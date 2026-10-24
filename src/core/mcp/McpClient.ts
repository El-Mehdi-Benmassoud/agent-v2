import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  McpServerConfig,
  McpTool,
  McpResource,
  McpPrompt,
  ToolResult,
  ToolContext,
} from '../../types/index.js';
import { ToolCategory, type ToolDefinition } from '../../types/index.js';

/**
 * MCPClient — connects to an MCP server via stdio/SSE/WS and exposes
 * its tools, resources, and prompts as agent tools.
 */
export class McpClient extends EventEmitter {
  readonly config: McpServerConfig;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private initialized = false;
  private serverCapabilities: { tools?: boolean; resources?: boolean; prompts?: boolean } = {};
  private tools: McpTool[] = [];
  private resources: McpResource[] = [];
  private prompts: McpPrompt[] = [];

  constructor(config: McpServerConfig) {
    super();
    this.config = config;
  }

  /** Connect to the MCP server. */
  async connect(): Promise<void> {
    if (this.initialized) return;

    const { command, args = [], env = {}, transport = 'stdio' } = this.config;

    if (transport === 'stdio') {
      this.process = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout!.on('data', (data: Buffer) => this.handleStdout(data));
      this.process.stderr!.on('data', (data: Buffer) => this.emit('stderr', data.toString()));
      this.process.on('error', (err) => this.emit('error', err));
      this.process.on('exit', (code, signal) => this.emit('exit', { code, signal }));
    } else if (transport === 'sse' || transport === 'websocket') {
      throw new Error(`Transport ${transport} not yet implemented`);
    }

    // Initialize the MCP connection
    const initResult = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'agent-v2', version: '0.2.0' },
    });

    this.serverCapabilities = initResult.capabilities || {};
    await this.request('notifications/initialized', {});

    // List available tools, resources, prompts
    if (this.serverCapabilities.tools) {
      const toolsResult = await this.request('tools/list', {});
      this.tools = (toolsResult.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    }

    if (this.serverCapabilities.resources) {
      const resourcesResult = await this.request('resources/list', {});
      this.resources = resourcesResult.resources || [];
    }

    if (this.serverCapabilities.prompts) {
      const promptsResult = await this.request('prompts/list', {});
      this.prompts = promptsResult.prompts || [];
    }

    this.initialized = true;
    this.emit('connected');
  }

  private handleStdout(data: Buffer): void {
    const lines = data.toString().split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        } else if (msg.method) {
          // Handle server notifications
          this.handleNotification(msg);
        }
      } catch (e) {
        this.emit('error', new Error(`Failed to parse MCP message: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  private handleNotification(msg: any): void {
    switch (msg.method) {
      case 'notifications/tools/list_changed':
        this.emit('toolsChanged');
        break;
      case 'notifications/resources/list_changed':
        this.emit('resourcesChanged');
        break;
      case 'notifications/prompts/list_changed':
        this.emit('promptsChanged');
        break;
      case 'notifications/progress':
        this.emit('progress', msg.params);
        break;
    }
  }

  private async request(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.process!.stdin!.write(JSON.stringify(msg) + '\n');

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** Call an MCP tool and return the result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.request('tools/call', { name, arguments: args });
    // MCP returns { content: [...], isError?: boolean }
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || 'MCP tool error');
    }
    return result.content?.[0]?.text || result.content;
  }

  /** Read an MCP resource. */
  async readResource(uri: string): Promise<any> {
    const result = await this.request('resources/read', { uri });
    return result.contents;
  }

  /** Get an MCP prompt. */
  async getPrompt(name: string, args?: Record<string, string>): Promise<any> {
    const result = await this.request('prompts/get', { name, arguments: args });
    return result.messages;
  }

  /** Get all available tools from this server. */
  getTools(): McpTool[] {
    return this.tools;
  }

  /** Get all available resources. */
  getResources(): McpResource[] {
    return this.resources;
  }

  /** Get all available prompts. */
  getPrompts(): McpPrompt[] {
    return this.prompts;
  }

  /** Disconnect from the server. */
  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.initialized = false;
    }
  }

  isConnected(): boolean {
    return this.initialized;
  }
}

/**
 * MCPManager — manages multiple MCP clients, converts MCP tools to
 * agent tools, and registers them in the global tool registry.
 */
export class McpManager extends EventEmitter {
  private clients = new Map<string, McpClient>();

  /** Connect to a server by name (from config). */
  async connectServer(name: string, config: McpServerConfig): Promise<McpClient> {
    if (this.clients.has(name)) {
      return this.clients.get(name)!;
    }

    const client = new McpClient(config);
    client.on('error', (err) => this.emit('error', { server: name, error: err }));
    client.on('exit', (info) => {
      this.emit('exit', { server: name, ...info });
      this.clients.delete(name);
    });

    await client.connect();
    this.clients.set(name, client);
    return client;
  }

  /** Disconnect a server. */
  async disconnectServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.disconnect();
      this.clients.delete(name);
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.disconnect();
    }
    this.clients.clear();
  }

  /** Get a connected client. */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** Get all connected server names. */
  getConnectedServers(): string[] {
    return [...this.clients.keys()];
  }
}

/**
 * Convert MCP tools to agent ToolDefinitions and register them.
 * Tool names are prefixed with the server name to avoid collisions.
 *
 * `registry` must be the ToolRegistry instance from src/tools/index.js.
 */
export function registerMcpTools(
  client: McpClient,
  serverName: string,
  registry: ToolRegistryLike
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const mcpTool of client.getTools()) {
    const prefixedName = `${serverName}_${mcpTool.name}`;

    const tool: ToolDefinition = {
      name: prefixedName,
      description: `[MCP: ${serverName}] ${mcpTool.description}`,
      category: ToolCategory.MCP,
      requiresApproval: false,
      dangerous: false,
      inputSchema: mcpTool.inputSchema,
      async execute(input, context) {
        try {
          const result = await client.callTool(mcpTool.name, input as Record<string, unknown>);
          return {
            success: true,
            output: result,
            metadata: { server: serverName, tool: mcpTool.name },
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            metadata: { server: serverName, tool: mcpTool.name },
          };
        }
      },
    };

    registry.register(tool);
    tools.push(tool);
  }

  return tools;
}

/** Structural type the ToolRegistry satisfies — avoids an import cycle. */
interface ToolRegistryLike {
  register(tool: ToolDefinition): void;
  unregister(name: string): boolean;
}

/** Unregister all MCP tools for a server (names are `<server>_<tool>`). */
export function unregisterMcpTools(
  serverName: string,
  registry: ToolRegistryLike & { getNames(): string[] }
): number {
  const prefix = `${serverName}_`;
  let removed = 0;
  for (const name of registry.getNames()) {
    if (name.startsWith(prefix) && registry.unregister(name)) {
      removed++;
    }
  }
  return removed;
}

export default McpClient;