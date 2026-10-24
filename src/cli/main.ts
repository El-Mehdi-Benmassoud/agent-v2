import { Command } from 'commander';
import chalk from 'chalk';
import { SessionManager } from '../core/session/SessionManager.js';
import { ProviderFactory } from '../core/providers/ProviderFactory.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { ProfileManager } from '../config/ProfileManager.js';
import { SkillRegistry } from '../core/skills/index.js';
import { AgentRegistry } from '../core/agents/AgentRegistry.js';
import { AgentLoader } from '../core/agents/AgentLoader.js';
import { McpManager, registerMcpTools } from '../core/mcp/index.js';
import { toolRegistry } from '../tools/index.js';
import { makeAgentTool } from '../tools/agent.js';
import { setAgentRegistry } from '../tools/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  ModelConfig,
  ModelProvider,
  ModelId,
  PermissionMode,
  SessionStatus,
  McpServerConfig,
} from '../types/index.js';

/** CLI application for agent-v2 */
export class AgentCLI {
  private program: Command;
  private sessionManager: SessionManager | null = null;
  private configManager: ConfigManager | null = null;
  private activeProfile = 'default';
  private skillRegistry: SkillRegistry | null = null;
  private agentRegistry: AgentRegistry | null = null;
  private mcpManager: McpManager | null = null;

  constructor() {
    this.program = new Command();
    this.setupProgram();
  }

  private setupProgram(): void {
    this.program
      .name('agent-v2')
      .description('A full-featured AI coding agent for desktop - inspired by Claude Code and Codex')
      .version('0.2.0')
      .addHelpText('after', `
Examples:
  $ agent-v2                    # Start interactive session
  $ agent-v2 chat "Fix the bug in auth.ts"  # One-shot query
  $ agent-v2 session list       # List sessions
  $ agent-v2 config set model.provider anthropic  # Set config
  $ agent-v2 tools list         # List available tools
      `);

    // Global options
    this.program
      .option('-p, --profile <profile>', 'Configuration profile to use', 'default')
      .option('--no-color', 'Disable colored output')
      .hook('preAction', (thisCommand) => {
              const opts = thisCommand.opts();
              const profile = opts['profile'] as string | undefined;
              if (profile) {
                this.activeProfile = profile;
                const config = this.getConfigManager().get();
                this.skillRegistry = config.skills?.enabled
                  ? new SkillRegistry({ ...config.skills })
                  : null;
                this.agentRegistry = new AgentRegistry(AgentLoader.defaultPaths());
                setAgentRegistry(this.agentRegistry);

                // Register the agent tool now that agentRegistry exists
                if (this.agentRegistry) {
                  toolRegistry.unregister('task');
                  toolRegistry.register(makeAgentTool(this.agentRegistry, toolRegistry.getNames(), {
                    provider: config.model.provider,
                    modelId: config.model.modelId as ModelId,
                    apiKey: config.model.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? 'test-key',
                  }));
                }

                // Initialize MCP manager and connect configured servers
                this.mcpManager = new McpManager();
                const mcpConfig = config.mcpServers || {};
                for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
                  this.mcpManager.connectServer(serverName, serverConfig as McpServerConfig)
                    .then((client) => {
                      registerMcpTools(client, serverName, toolRegistry);
                    })
                    .catch((err) => {
                      console.error(chalk.red(`Failed to connect to MCP server ${serverName}: ${err.message}`));
                    });
                }

                this.sessionManager = new SessionManager({
                  requestApproval: this.handleApproval.bind(this),
                  hooks: config.hooks,
                  skills: config.skills,
                  skillRegistry: this.skillRegistry,
                });
              }
            });

    // tui command
    this.program
      .command('tui')
      .description('Start the interactive TUI (Ink-based terminal interface)')
      .action(async () => {
        await this.handleTui();
      });

    // chat command
    this.program
      .command('chat [message...]')
      .description('Start interactive chat or send a one-shot message')
      .option('--stream', 'Stream response', true)
      .option('--no-stream', 'Disable streaming')
      .option('-m, --model <model>', 'Model to use')
      .option('--max-turns <turns>', 'Maximum turns', '50')
      .option('--max-budget <usd>', 'Maximum budget in USD', '5')
      .option('--permission-mode <mode>', 'Permission mode', 'default')
      .option('--allowed-tools <tools...>', 'Allowed tools')
      .option('--disallowed-tools <tools...>', 'Disallowed tools')
      .action(async (message, options) => {
        await this.handleChat(message.join(' '), options);
      });

    // session commands
    const sessionCmd = this.program.command('session').description('Manage sessions');
    sessionCmd.command('list').description('List all sessions').action(() => this.handleSessionList());
    sessionCmd.command('new [name]').description('Create a new session').option('-p, --path <path>', 'Project path', process.cwd()).action((name, opts) => this.handleSessionNew(name, opts));
    sessionCmd.command('switch <id>').description('Switch to a session').action((id) => this.handleSessionSwitch(id));
    sessionCmd.command('delete <id>').description('Delete a session').action((id) => this.handleSessionDelete(id));
    sessionCmd.command('export <id> [file]').description('Export session to file').action((id, file) => this.handleSessionExport(id, file));
    sessionCmd.command('import <file>').description('Import session from file').action((file) => this.handleSessionImport(file));
    sessionCmd.command('compact <id>').description('Compact session context').option('-f, --focus <focus>', 'Focus area').action((id, opts) => this.handleSessionCompact(id, opts));

    // config commands
    const configCmd = this.program.command('config').description('Manage configuration');
    configCmd.command('show').description('Show current configuration').option('--json', 'Output as JSON').action((opts) => this.handleConfigShow(opts));
    configCmd.command('get <key>').description('Get a configuration value').action((key) => this.handleConfigGet(key));
    configCmd.command('set <key> <value>').description('Set a configuration value').action((key, value) => this.handleConfigSet(key, value));
    configCmd.command('reset').description('Reset configuration to defaults').action(() => this.handleConfigReset());
    configCmd.command('edit').description('Open configuration in editor').action(() => this.handleConfigEdit());
    configCmd.command('profiles').description('List available profiles').action(() => this.handleConfigProfiles());
    configCmd.command('profile <name>').description('Switch or create profile').action((name) => this.handleConfigProfile(name));

    // tools commands
    const toolsCmd = this.program.command('tools').description('Manage tools');
    toolsCmd.command('list').description('List available tools').option('-c, --category <category>', 'Filter by category').action((opts) => this.handleToolsList(opts));
    toolsCmd.command('info <name>').description('Show tool information').action((name) => this.handleToolsInfo(name));

    // model commands
    const modelCmd = this.program.command('model').description('Manage models');
    modelCmd.command('list').description('List available models').action(() => this.handleModelList());
    modelCmd.command('current').description('Show current model').action(() => this.handleModelCurrent());
    modelCmd.command('set <provider> <modelId>').description('Set model').action((provider, modelId) => this.handleModelSet(provider, modelId));
    modelCmd.command('test').description('Test model connection').action(() => this.handleModelTest());

    // workspace commands
    const workspaceCmd = this.program.command('workspace').description('Manage workspace');
    workspaceCmd.command('init [path]').description('Initialize workspace').option('-n, --name <name>', 'Workspace name').action((path, opts) => this.handleWorkspaceInit(path, opts));
    workspaceCmd.command('info').description('Show workspace info').action(() => this.handleWorkspaceInfo());

    // skills commands
    const skillsCmd = this.program.command('skills').description('Manage skills');
    skillsCmd.command('list').description('List available skills').action(() => this.handleSkillsList());
    skillsCmd.command('install <name>').description('Install a skill').action((name) => this.handleSkillsInstall(name));
    skillsCmd.command('create <name>').description('Create a new skill').action((name) => this.handleSkillsCreate(name));

    // agent commands
    const agentCmd = this.program.command('agent').description('Manage agents');
    agentCmd.command('list').description('List available agents').action(() => this.handleAgentList());
    agentCmd.command('create <name>').description('Create a new agent').action((name) => this.handleAgentCreate(name));

    // MCP commands
    const mcpCmd = this.program.command('mcp').description('Manage MCP servers');
    mcpCmd.command('list').description('List connected MCP servers').action(() => this.handleMcpList());
    mcpCmd.command('connect <name>').description('Connect to an MCP server')
      .option('-c, --command <command>', 'Command to run the server')
      .option('-a, --args <args...>', 'Arguments for the command')
      .option('-e, --env <env...>', 'Environment variables (KEY=value)')
      .action((name, opts) => this.handleMcpConnect(name, opts));
    mcpCmd.command('disconnect <name>').description('Disconnect from an MCP server').action((name) => this.handleMcpDisconnect(name));

    // doctor command
    this.program.command('doctor').description('Run health checks').action(() => this.handleDoctor());

    // update command
    this.program.command('update').description('Check for updates').option('--check-only', 'Only check, do not update').action((opts) => this.handleUpdate(opts));

    // completion command
    this.program.command('completion [shell]').description('Generate shell completion').action((shell) => this.handleCompletion(shell));
  }

  private async handleApproval(
    request: { sessionId: string; toolName: string; input: unknown; approve: () => void; deny: (reason?: string) => void }
  ): Promise<boolean> {
    console.log(chalk.yellow(`\n⚠️  Tool ${request.toolName} requires approval`));
    console.log(chalk.gray(`   Input: ${JSON.stringify(request.input).slice(0, 200)}`));

    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.cyan('   Allow? (y/n): '), (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    });

    if (answer === 'y' || answer === 'yes') {
      request.approve();
      return true;
    }

    request.deny(`User denied: ${answer}`);
    return false;
  }

  /**
   * Launch the Ink TUI. Resumes the current session when one exists,
   * otherwise creates one from config (same construction as chat).
   * Requires raw-mode stdin: refuses with a clear message when piped.
   */
  private async handleTui(): Promise<void> {
    if (!process.stdin.isTTY) {
      console.error(chalk.red('The TUI needs a terminal (raw-mode stdin).'));
      console.error(chalk.gray('Use `agent-v2 chat <message>` for piped input, or run this in a terminal.'));
      return;
    }

    if (!this.sessionManager) {
      this.sessionManager = new SessionManager({
        requestApproval: this.handleApproval.bind(this),
        hooks: this.getConfigManager().get().hooks,
        skills: this.getConfigManager().get().skills,
        skillRegistry: this.skillRegistry,
      });
    }

    this.sessionManager.getCurrentSession();
    const session = this.sessionManager.getCurrentSession();
    if (!session) {
      const config = this.getConfigManager().get();
      try {
        await this.sessionManager.createSession(
          { ...config.model, apiKey: config.model.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? 'test-key' },
          [],
          {
            workingDirectory: config.workspace.rootPath,
            permissionMode: config.permissions.mode,
          }
        );
      } catch (error) {
        console.error(chalk.red(`Cannot create session: ${error instanceof Error ? error.message : String(error)}`));
        console.error(chalk.gray('  Set your API key first: agent-v2 config set model.apiKey <key>'));
        return;
      }
    }

    // Mount the TUI. renderTUI takes over the terminal until the user exits.
    const { renderTUI } = await import('../tui/render.js');
    renderTUI(this.sessionManager);
  }

  private async handleChat(message: string, options: any): Promise<void> {
      if (!this.sessionManager) {
        this.sessionManager = new SessionManager({ requestApproval: this.handleApproval.bind(this) });
      }

      let session = this.sessionManager.getCurrentSession();
      if (!session) {
        const fullConfig = this.getConfigManager().get();
        const configModel = fullConfig.model;
        const configWorkspace = fullConfig.workspace;

        const modelConfig: ModelConfig = {
          ...configModel,
          apiKey: configModel.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'],
          ...(options.model ? { modelId: options.model } : {}),
          maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : configModel.maxTurns,
          maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : configModel.maxBudgetUsd,
        };

        session = await this.sessionManager.createSession(modelConfig, [], {
          workingDirectory: configWorkspace.rootPath,
          permissionMode: (options.permissionMode as PermissionMode) ?? fullConfig.permissions.mode,
          maxBudgetUsd: modelConfig.maxBudgetUsd,
        });
      }

    if (message) {
      console.log(chalk.cyan('You: ') + message);
      const result = await this.sessionManager.sendMessage(message, {
        stream: options.stream,
        permissionMode: options.permissionMode as PermissionMode,
      });
      
      for (const msg of session.messages) {
        if (msg.role === 'assistant') {
          console.log(chalk.green('Agent: ') + this.formatMessage(msg));
        }
      }
    } else {
      console.log(chalk.green('Starting interactive session...'));
      console.log(chalk.gray('Type "exit" or press Ctrl+C to quit\n'));
      await this.runInteractiveSession(session);
    }
  }

  private formatMessage(msg: any): string {
    return JSON.stringify(msg.content);
  }

  private async runInteractiveSession(session: any): Promise<void> {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan('> '),
    });

    rl.prompt();

    rl.on('line', async (input) => {
      const trimmed = input.trim();
      if (trimmed === 'exit' || trimmed === 'quit') {
        rl.close();
        return;
      }

      if (trimmed) {
        try {
          const result = await this.sessionManager!.sendMessage(trimmed, { stream: true });
          for (const msg of session.messages) {
            if (msg.role === 'assistant') {
              console.log(chalk.green('Agent: ') + this.formatMessage(msg));
            }
          }
        } catch (error) {
          console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      rl.prompt();
    });

    rl.on('close', () => {
      console.log(chalk.gray('\nGoodbye!'));
      process.exit(0);
    });
  }

  // Session handlers
  private handleSessionList(): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    const sessions = this.sessionManager.listSessions();
    if (sessions.length === 0) {
      console.log(chalk.yellow('No sessions found'));
      return;
    }
    console.log(chalk.bold('\nSessions:'));
    for (const session of sessions) {
      const current = session.config.id === this.sessionManager!.getCurrentSession()?.config.id ? '*' : ' ';
      console.log(`  ${current} ${session.config.id.slice(0, 8)} - ${session.config.workingDirectory} (${session.status}) - ${session.messages.length} msgs, $${session.totalCostUsd.toFixed(4)}`);
    }
  }

  private async handleSessionNew(name: string | undefined, options: any): Promise<void> {
    if (!this.sessionManager) this.sessionManager = new SessionManager({ requestApproval: this.handleApproval.bind(this) });
    const config = this.getConfigManager().get();
    const modelConfig: ModelConfig = {
      ...config.model,
      apiKey: config.model.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'],
    };
    let session;
    try {
      session = await this.sessionManager.createSession(modelConfig, [], {
        workingDirectory: options.path || config.workspace.rootPath,
        permissionMode: config.permissions.mode,
      });
    } catch (error) {
      console.log(chalk.red(`Cannot create session: ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.gray('  Set your API key first, e.g.: agent-v2 config set model.apiKey <key>'));
      console.log(chalk.gray('  or export ANTHROPIC_API_KEY / OPENAI_API_KEY.'));
      return;
    }
    console.log(chalk.green(`Created session: ${session.config.id}`));
  }

  private handleSessionSwitch(id: string): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    if (this.sessionManager!.setCurrentSession(id)) {
      console.log(chalk.green(`Switched to session: ${id}`));
    } else {
      console.log(chalk.red(`Session not found: ${id}`));
    }
  }

  private handleSessionDelete(id: string): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    if (this.sessionManager!.deleteSession(id)) {
      console.log(chalk.green(`Deleted session: ${id}`));
    } else {
      console.log(chalk.red(`Session not found: ${id}`));
    }
  }

  private handleSessionExport(id: string, file?: string): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    const json = this.sessionManager!.exportSession(id);
    if (!json) {
      console.log(chalk.red(`Session not found: ${id}`));
      return;
    }
    const outputPath = file || join(process.cwd(), `session-${id.slice(0, 8)}.json`);
    writeFileSync(outputPath, json);
    console.log(chalk.green(`Exported to: ${outputPath}`));
  }

  private handleSessionImport(file: string): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    if (!existsSync(file)) {
      console.log(chalk.red(`File not found: ${file}`));
      return;
    }
    const json = readFileSync(file, 'utf-8');
    const session = this.sessionManager!.importSession(json);
    console.log(chalk.green(`Imported session: ${session.config.id}`));
  }

  private handleSessionCompact(id: string, options: any): void {
    if (!this.sessionManager) this.sessionManager = new SessionManager({});
    const compacted = this.sessionManager!.compactSession(id, options.focus);
    console.log(
      compacted
        ? chalk.green(`Compacted session: ${id}`)
        : chalk.yellow(`Session ${id} not found or history too small to compact`)
    );
  }

  // Config, model, and workspace handlers (backed by ConfigManager)
  private getConfigManager(): ConfigManager {
    if (!this.configManager || this.configManager.getProfile() !== this.activeProfile) {
      this.configManager = new ConfigManager(this.activeProfile);
    }
    return this.configManager;
  }

  private handleConfigShow(opts: any): void {
    const config = this.getConfigManager().get();
    if (opts.json) {
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.log(chalk.bold('\nConfiguration:'));
      console.log(`  Profile: ${config.profile}`);
      console.log(`  Model: ${config.model.provider} / ${config.model.modelId}`);
      console.log(`  Max Tokens: ${config.model.maxTokens}`);
      console.log(`  Temperature: ${config.model.temperature}`);
      console.log(`  Workspace: ${config.workspace.rootPath}`);
      console.log(`  Permission Mode: ${config.permissions.mode}`);
      console.log(`  Theme: ${config.ui.theme}`);
    }
  }

  private handleConfigGet(key: string): void {
    const value = this.getConfigManager().getValue(key);
    if (value === undefined) {
      console.log(chalk.red(`Key not found: ${key}`));
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
  }

  private handleConfigSet(key: string, value: string): void {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      this.getConfigManager().set(key, parsed);
      console.log(chalk.green(`Set ${key} = ${JSON.stringify(parsed)}`));
    } catch (error) {
      console.log(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private handleConfigReset(): void {
    this.getConfigManager().reset();
    console.log(chalk.green('Configuration reset to defaults'));
  }

  private handleConfigEdit(): void {
    const path = this.getConfigManager().getConfigPath();
    console.log(chalk.yellow(`Config file: ${path}`));
    console.log(chalk.gray('Open it in your editor to modify'));
  }

  private handleConfigProfiles(): void {
    const pm = new ProfileManager();
    const profiles = pm.list();
    if (profiles.length === 0) {
      console.log(chalk.yellow('No profiles found'));
      return;
    }
    console.log(chalk.bold('\nProfiles:'));
    for (const name of profiles) {
      const marker = name === this.activeProfile ? '*' : ' ';
      console.log(`  ${marker} ${name}`);
    }
  }

  private handleConfigProfile(name: string): void {
    this.getConfigManager().get();
    const pm = new ProfileManager();
    if (!pm.exists(name)) {
      pm.create(name, this.activeProfile);
      console.log(chalk.green(`Created profile: ${name}`));
    } else {
      console.log(chalk.green(`Switched to profile: ${name}`));
    }
    this.activeProfile = name;
    pm.setActiveProfile(name);
    this.configManager = new ConfigManager(name);
  }

  private handleModelCurrent(): void {
    const config = this.getConfigManager().get();
    console.log(`${config.model.provider} / ${config.model.modelId}`);
  }

  private handleModelSet(provider: string, modelId: string): void {
    const cm = this.getConfigManager();
    cm.set('model.provider', provider);
    cm.set('model.modelId', modelId);
    console.log(chalk.green(`Model set to: ${provider} / ${modelId}`));
  }

  private async handleModelTest(): Promise<void> {
    const config = this.getConfigManager().get().model;
    try {
      const provider = await ProviderFactory.createAndValidate(config);
      const caps = provider.getCapabilities();
      console.log(chalk.green('Model connection OK (key present)'));
      console.log(`  Model: ${provider.getModelId()}`);
      console.log(`  Context: ${caps.maxContextTokens} tokens`);
      console.log(`  Max output: ${caps.maxOutputTokens} tokens`);
      console.log(`  Tools: ${caps.supportsTools ? 'yes' : 'no'} | Streaming: ${caps.supportsStreaming ? 'yes' : 'no'}`);
    } catch (error) {
      console.log(chalk.red(`Model test failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private handleWorkspaceInit(path: string = '.', options: any): void {
    const workspacePath = join(process.cwd(), path);
    const cm = this.getConfigManager();
    cm.set('workspace.rootPath', workspacePath);
    console.log(chalk.green(`Workspace initialized at: ${workspacePath}`));
  }

  private handleWorkspaceInfo(): void {
    const ws = this.getConfigManager().get().workspace;
    console.log(chalk.bold('\nWorkspace:'));
    console.log(`  Root: ${ws.rootPath}`);
    console.log(`  Max file size: ${ws.maxFileSize} bytes`);
  }

  // Tools handlers
  private handleToolsList(opts: any): void {
    let tools = toolRegistry.getAll();
    if (opts.category) {
      tools = tools.filter((t) => t.category === opts.category);
    }
    console.log(chalk.bold('\nAvailable Tools:'));
    for (const tool of tools) {
      const approval = tool.requiresApproval ? chalk.yellow(' [approval]') : '';
      const dangerous = tool.dangerous ? chalk.red(' [DANGEROUS]') : '';
      console.log(`  ${chalk.cyan(tool.name)} (${tool.category})${approval}${dangerous}`);
      console.log(`    ${tool.description}`);
    }
  }

  private handleToolsInfo(name: string): void {
    const tool = toolRegistry.get(name);
    if (!tool) {
      console.log(chalk.red(`Tool not found: ${name}`));
      return;
    }
    console.log(chalk.bold(`\n${tool.name}`));
    console.log(`  Description: ${tool.description}`);
    console.log(`  Category: ${tool.category}`);
    console.log(`  Requires Approval: ${tool.requiresApproval ? 'Yes' : 'No'}`);
    console.log(`  Dangerous: ${tool.dangerous ? 'Yes' : 'No'}`);
    console.log(`  Input Schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
  }

  // Model handlers
  private handleModelList(): void {
    console.log(chalk.bold('\nAvailable Models:'));
    console.log(chalk.cyan('\nAnthropic:'));
    console.log('  claude-opus-4-20250514');
    console.log('  claude-sonnet-4-20250514');
    console.log('  claude-3-5-haiku-20241022');
    console.log(chalk.cyan('\nOpenAI:'));
    console.log('  gpt-4o');
    console.log('  gpt-4o-mini');
    console.log('  gpt-4-turbo');
    console.log('  o1-preview');
    console.log('  o1-mini');
  }

  private handleSkillsList(): void {
    if (!this.skillRegistry) {
      console.log(chalk.yellow('Skills not configured. Enable in config: skills.enabled = true'));
      return;
    }
    const skills = this.skillRegistry.getAll();
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills loaded'));
      return;
    }
    console.log(chalk.bold('\nLoaded Skills:'));
    for (const skill of skills) {
      const d = skill.definition;
      const triggers = d.triggers.length > 0 ? chalk.gray(` (triggers: ${d.triggers.join(', ')})`) : '';
      console.log(`  ${chalk.cyan(d.name)} v${d.version}${triggers}`);
      console.log(`    ${d.description}`);
    }
  }

  private handleSkillsInstall(name: string): void {
    if (!this.skillRegistry) {
      console.log(chalk.yellow('Skills not configured. Enable in config: skills.enabled = true'));
      return;
    }
    const config = this.getConfigManager().get();
    const paths = config.skills?.paths ?? ['.agent-v2/skills', '~/.agent-v2/skills'];
    const raw = paths[0] ?? '.agent-v2/skills';
    const firstPath = raw.startsWith('~/')
      ? join(homedir(), raw.slice(2))
      : raw;

    mkdirSync(firstPath, { recursive: true });
    const targetPath = join(firstPath, `${name}.md`);

    if (existsSync(targetPath)) {
      console.log(chalk.yellow(`Skill already exists: ${targetPath}`));
      return;
    }

    // Minimal template frontmatter + body (block-sequence YAML: the built-in
    // parser handles `- item` lists but not inline `[]`)
    const template = `---
name: ${name}
description: ${name} skill
version: 1.0.0
triggers:
  -
---

# Instructions for ${name}

Add your skill instructions here.`;
    writeFileSync(targetPath, template, 'utf-8');
    console.log(chalk.green(`Created skill: ${targetPath}`));

    // Reload registry to pick up the new skill
    this.skillRegistry!.reloadAll();
    console.log(chalk.gray('SkillRegistry reloaded.'));
  }

  private handleSkillsCreate(name: string): void {
    if (!this.skillRegistry) {
      console.log(chalk.yellow('Skills not configured. Enable in config: skills.enabled = true'));
      return;
    }
    const config = this.getConfigManager().get();
    const paths = config.skills?.paths ?? ['.agent-v2/skills', '~/.agent-v2/skills'];
    const raw = paths[0] ?? '.agent-v2/skills';
    const firstPath = raw.startsWith('~/')
      ? join(homedir(), raw.slice(2))
      : raw;

    mkdirSync(firstPath, { recursive: true });
    const targetPath = join(firstPath, `${name}.md`);

    if (existsSync(targetPath)) {
      console.log(chalk.yellow(`Skill already exists: ${targetPath}`));
      console.log(chalk.gray('Opening in editor...'));
    } else {
      // Minimal template. NOTE: frontmatter must sit flush-left; the built-in
      // YAML parser reads `key: value` lines and `- item` sequences.
      const template = [
        '---',
        `name: ${name}`,
        `description: ${name} skill`,
        'version: 1.0.0',
        'triggers:',
        '---',
        '',
        `# Instructions for ${name}`,
        '',
        'Add your skill instructions here.',
      ].join('\n');
      writeFileSync(targetPath, template, 'utf-8');
      console.log(chalk.green(`Created skill: ${targetPath}`));
    }

    // Open in editor (interactive sessions only; skip silently when piped)
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'code';
      const child = spawn(editor, [targetPath], { stdio: 'inherit' });
      child.on('error', () => {
        console.log(chalk.gray(`(Could not launch '${editor}' — edit ${targetPath} manually.)`));
        this.skillRegistry?.reloadAll();
      });
      child.on('exit', () => {
        console.log(chalk.gray('Reloading skill registry...'));
        this.skillRegistry?.reloadAll();
      });
    } else {
      console.log(chalk.gray(`Edit it at: ${targetPath}`));
      this.skillRegistry?.reloadAll();
    }
  }

  private handleAgentCreate(name: string): void {
    const paths = AgentLoader.defaultPaths();
    const raw = paths[0] ?? '.agent-v2/agents';
    const firstPath = raw.startsWith('~/')
      ? join(homedir(), raw.slice(2))
      : raw;

    mkdirSync(firstPath, { recursive: true });
    const targetPath = join(firstPath, `${name}.md`);

    if (existsSync(targetPath)) {
      console.log(chalk.yellow(`Agent already exists: ${targetPath}`));
      console.log(chalk.gray('Opening in editor...'));
    } else {
      // Create minimal agent template with frontmatter
      const template = `---
name: ${name}
description: ${name} agent - describe when to use this agent
tools: read, grep, bash
denied-tools: write, edit
model: inherit
---

You are a ${name} agent. Focus on your specific domain.

When invoked:
1. Analyze the task
2. Use your allowed tools
3. Report findings clearly`;
      writeFileSync(targetPath, template, 'utf-8');
      console.log(chalk.green(`Created agent: ${targetPath}`));
    }

    // Open in editor (interactive sessions only; skip silently when piped)
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'code';
      const child = spawn(editor, [targetPath], { stdio: 'inherit' });
      child.on('error', () => {
        console.log(chalk.gray(`(Could not launch '${editor}' — edit ${targetPath} manually.)`));
        this.agentRegistry?.reloadAll();
      });
      child.on('exit', () => {
        console.log(chalk.gray('Reloading agent registry...'));
        this.agentRegistry?.reloadAll();
      });
    } else {
      console.log(chalk.gray(`Edit it at: ${targetPath}`));
      this.agentRegistry?.reloadAll();
    }
  }

  private handleMcpList(): void {
    if (!this.mcpManager) {
      console.log(chalk.yellow('MCP not initialized. Run with a profile that has mcpServers configured.'));
      return;
    }
    const servers = this.mcpManager.getConnectedServers();
    if (servers.length === 0) {
      console.log(chalk.yellow('No MCP servers connected.'));
      return;
    }
    console.log(chalk.bold('\nConnected MCP Servers:'));
    for (const name of servers) {
      console.log(`  ${chalk.cyan(name)}`);
    }
  }

  private async handleMcpConnect(name: string, options: any): Promise<void> {
    if (!this.mcpManager) {
      console.log(chalk.red('MCP not initialized.'));
      return;
    }
    const config = this.getConfigManager().get();
    const serverConfig = config.mcpServers?.[name];
    if (!serverConfig) {
      console.log(chalk.red(`MCP server ${name} not found in config.`));
      return;
    }
    try {
      const client = await this.mcpManager.connectServer(name, serverConfig);
      registerMcpTools(client, name, toolRegistry);
      console.log(chalk.green(`Connected to MCP server: ${name}`));
      const tools = client.getTools();
      console.log(`  Registered ${tools.length} tools`);
    } catch (err) {
      console.log(chalk.red(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async handleMcpDisconnect(name: string): Promise<void> {
    if (!this.mcpManager) {
      console.log(chalk.red('MCP not initialized.'));
      return;
    }
    await this.mcpManager.disconnectServer(name);
    console.log(chalk.green(`Disconnected from MCP server: ${name}`));
  }

  private handleAgentList(): void {
    if (!this.agentRegistry) {
      console.log(chalk.yellow('Agents not configured.'));
      return;
    }
    const agents = this.agentRegistry.getAll();
    if (agents.length === 0) {
      console.log(chalk.yellow('No agents available'));
      return;
    }
    console.log(chalk.bold('\nAvailable Agents:'));
    for (const agent of agents) {
      console.log(`  ${chalk.cyan(agent.agentType)}: ${agent.whenToUse}`);
    }
  }

  // Doctor
  private async handleDoctor(): Promise<void> {
    console.log(chalk.bold('\n🏥 Running health checks...\n'));
    let allPassed = true;

    // Node version
    const nodeVersion = process.version;
    const versionParts = nodeVersion.slice(1).split('.');
    const majorVersion = parseInt(versionParts[0] || '0', 10);
    if (majorVersion >= 20) {
      console.log(chalk.green(`✓ Node.js ${nodeVersion} (>= 20 required)`));
    } else {
      console.log(chalk.red(`✗ Node.js ${nodeVersion} (>= 20 required)`));
      allPassed = false;
    }

    // Config
    const validation = this.getConfigManager().validate();
    if (validation.valid) {
      console.log(chalk.green(`✓ Configuration valid (profile: ${this.activeProfile})`));
    } else {
      console.log(chalk.red('✗ Configuration invalid:'));
      for (const err of validation.errors) {
        console.log(chalk.red(`  - ${err}`));
      }
      allPassed = false;
    }

    // Provider
    try {
      const providerConfig = this.getConfigManager().get().model;
      const provider = await ProviderFactory.createAndValidate({
        ...providerConfig,
        apiKey: providerConfig.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['OPENAI_API_KEY'],
      });
      console.log(chalk.green(`✓ Model provider (${providerConfig.provider}) configured`));
    } catch (error) {
      console.log(chalk.red(`✗ Model provider error: ${error instanceof Error ? error.message : String(error)}`));
      allPassed = false;
    }

    // Workspace
    if (existsSync(process.cwd())) {
      console.log(chalk.green(`✓ Workspace exists: ${process.cwd()}`));
    } else {
      console.log(chalk.yellow(`⚠ Workspace not found`));
    }

    // Git
    try {
      const { spawnSync } = await import('node:child_process');
      const gitResult = spawnSync('git', ['--version'], { encoding: 'utf-8' });
      if (gitResult.status === 0) {
        console.log(chalk.green(`✓ Git available: ${gitResult.stdout.trim()}`));
      } else {
        console.log(chalk.yellow('⚠ Git not found'));
      }
    } catch {
      console.log(chalk.yellow('⚠ Git not found'));
    }

    // Tools
    console.log(chalk.green(`✓ ${toolRegistry.getAll().length} tools registered`));

    console.log(chalk.bold(`\n${allPassed ? chalk.green('All checks passed!') : chalk.red('Some checks failed')}`));
  }

  // Update
  private handleUpdate(opts: any): void { console.log(chalk.yellow('Update check - not yet implemented')); }

  // Completion
  private handleCompletion(shell?: string): void {
    const shells = ['bash', 'zsh', 'fish', 'powershell'];
    const targetShell = shell || ((process.env['SHELL'] as string | undefined)?.split('/').pop() || 'bash');
    if (!shells.includes(targetShell)) {
      console.log(chalk.red(`Unsupported shell: ${targetShell}`));
      return;
    }
    console.log(`# Completion for ${targetShell} not yet implemented`);
  }

  /** Run the CLI */
  async run(args: string[] = process.argv.slice(2)): Promise<void> {
    try {
      // `{ from: 'user' }` is REQUIRED: without it commander applies the
      // 'node' convention and strips 2 MORE args (node + script), eating
      // the first subcommand tokens. Same bug as v1, same fix.
      await this.program.parseAsync(args, { from: 'user' });
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    } finally {
      // Cleanup MCP connections
      if (this.mcpManager) {
        await this.mcpManager.disconnectAll();
      }
    }
  }
}

export default AgentCLI;
