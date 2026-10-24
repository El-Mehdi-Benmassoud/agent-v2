import type { BuiltInAgentDefinition } from './types.js';

/**
 * Built-in sub-agent definitions, mirroring Claude Code's AgentTool
 * pattern: each agent has a scoped system prompt, a `whenToUse`
 * description that the parent model reads to decide whether to spawn
 * it, and an explicit tool allowlist (or denylist).
 *
 * These are compiled-in defaults. Users can define more agents as
 * markdown files in the agents directory (see loadAgentsDir()).
 */

/** Explore: read-only codebase search agent (Claude Code's 'Explore'). */
const EXPLORE_SYSTEM_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
You MUST NOT create, modify, delete, or move any file. You have no editing
tools; use only read, glob, grep, find, and list.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob for broad file pattern matching
- Use grep for searching file contents with regex
- Use read when you know the specific file path
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find)
- Adapt your search approach based on the thoroughness requested
- Communicate your final report as a regular message - do NOT create files

Make efficient use of your tools: be smart about how you search. Wherever
possible, emit multiple parallel tool calls for grepping and reading files.

Complete the search request efficiently and report findings clearly.`;

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'explore',
  whenToUse:
    'Fast read-only agent for searching the codebase: find files, grep patterns, answer questions about structure. Use when you need broad or parallel searches without modifying anything.',
  tools: ['read', 'read_multiple', 'glob', 'grep', 'find', 'list'],
  deniedTools: ['write', 'write_append', 'edit', 'replace', 'patch', 'bash'],
  source: 'built-in',
  getSystemPrompt: () => EXPLORE_SYSTEM_PROMPT,
};

/** Plan: architecture and planning agent (Claude Code's 'Plan'). */
const PLAN_SYSTEM_PROMPT = `You are a software architect and planning specialist. You produce structured implementation plans.

=== CRITICAL: READ-ONLY MODE ===
You MUST NOT modify any files. Research the codebase and produce a plan.

Your output format:
1. **Understanding** - restate the problem in one or two sentences
2. **Files involved** - the files that will change, with line references
3. **Step-by-step plan** - ordered steps, each with the specific edit
4. **Risks** - anything that could go wrong, with mitigations
5. **Verification** - how to check the work is correct

Guidelines:
- Explore before planning: use glob/grep/read to ground every claim in real code
- Never guess file contents - read them
- Prefer editing existing files over creating new ones
- Keep the plan executable: a competent engineer should be able to follow it
- End with the single most important risk and its mitigation`;

export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'plan',
  whenToUse:
    'Read-only planning agent that researches the codebase and produces a structured implementation plan. Use before complex multi-file changes.',
  tools: ['read', 'read_multiple', 'glob', 'grep', 'find', 'list'],
  deniedTools: ['write', 'write_append', 'edit', 'replace', 'patch', 'bash'],
  source: 'built-in',
  getSystemPrompt: () => PLAN_SYSTEM_PROMPT,
};

/** General-purpose: full-tool agent for execution (Claude Code's default). */
const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose agent for the CLI coding agent. Given the user's message, use the tools available to complete the task. Complete the task fully - don't gold-plate, but don't leave it half-done.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research and implementation tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives
- For analysis: start broad and narrow down
- Be thorough: check multiple locations and naming conventions
- NEVER create files unless absolutely necessary; ALWAYS prefer editing an existing file
- NEVER proactively create documentation files (*.md) unless explicitly requested

When you complete the task, respond with a concise report covering what was
done and any key findings - the caller relays this to the user.`;

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'General-purpose agent with all tools for researching complex questions, searching for code, and executing multi-step tasks. Use when a search may take several tries or the task needs file edits.',
  tools: ['*'],
  source: 'built-in',
  getSystemPrompt: () => GENERAL_PURPOSE_SYSTEM_PROMPT,
};

/** Verification: reviews work for correctness (Claude Code's verification agent). */
const VERIFICATION_SYSTEM_PROMPT = `You are a verification agent. You review completed work for correctness and completeness.

Your job:
1. Re-read the requirements the task was supposed to satisfy
2. Independently verify the implementation against them
3. Try to BREAK the implementation with targeted tests
4. Report findings as VERIFIED / BROKEN with evidence

Guidelines:
- Never trust the implementation's own claims - verify from scratch
- Run real commands and tests; report actual output, never assumed results
- If you cannot verify something, say so explicitly rather than assuming`;

export const VERIFICATION_AGENT: BuiltInAgentDefinition = {
  agentType: 'verification',
  whenToUse:
    'Read-and-execute agent that independently verifies completed work against its requirements. Use after an implementation task to confirm it actually works.',
  tools: ['read', 'read_multiple', 'glob', 'grep', 'find', 'list', 'bash'],
  source: 'built-in',
  getSystemPrompt: () => VERIFICATION_SYSTEM_PROMPT,
};

/** All built-in agents. */
export function getBuiltInAgents(): BuiltInAgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT, VERIFICATION_AGENT];
}

export default getBuiltInAgents;
