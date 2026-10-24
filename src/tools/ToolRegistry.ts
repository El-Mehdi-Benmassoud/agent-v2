import { valueMatchesType } from './shared.js';
import type { ToolDefinition, ToolResult, ToolContext, ToolCategory } from '../types/index.js';

/**
 * ToolRegistry — the v2 tool catalog. Tools self-register with an embedded
 * execute() (per v2 ToolDefinition), and the registry owns input validation
 * before dispatch plus error containment around handler throws.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool. Overwrites any existing tool with the same name. */
  register(tool: ToolDefinition): void {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error('Tool must have a non-empty name');
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool "${tool.name}" must have an execute function`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name. Returns true when a tool was removed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Look up a tool definition by name. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** All registered tool definitions. */
  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** All registered tool names. */
  getNames(): string[] {
    return [...this.tools.keys()];
  }

  /** All tools in a given category. */
  getByCategory(category: ToolCategory): ToolDefinition[] {
    return this.getAll().filter((tool) => tool.category === category);
  }

  /** Whether a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Validate raw input against a tool's inputSchema.
   * Zod schemas (anything exposing .parse) are invoked inside try/catch;
   * plain JSON-Schema-style objects get a minimal structural check:
   * required keys present and declared property types respected.
   */
  validateInput(tool: ToolDefinition, input: unknown): { valid: boolean; error?: string } {
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    if (!schema || typeof schema !== 'object') {
      return { valid: true };
    }

    // Zod-style schema: has a parse function
    if (typeof (schema as { parse?: unknown }).parse === 'function') {
      try {
        (schema as { parse: (input: unknown) => unknown }).parse(input);
        return { valid: true };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : JSON.stringify(error ?? 'invalid input');
        return { valid: false, error: `Input validation failed: ${message}` };
      }
    }

    // Minimal JSON-Schema-style check
    const typeOk = !('type' in schema) || schema['type'] === 'object';
    if (!typeOk) {
      return { valid: true }; // not an object schema; nothing structural to check
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { valid: false, error: 'Input validation failed: input must be an object' };
    }

    const record = input as Record<string, unknown>;
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in record)) {
          return { valid: false, error: `Input validation failed: missing required property "${key}"` };
        }
      }
    }

    const properties = schema['properties'];
    if (properties && typeof properties === 'object') {
      for (const [key, def] of Object.entries(properties as Record<string, unknown>)) {
        if (!(key in record)) continue;
        const value = record[key];
        if (value === undefined) continue;
        const expectedType = (def as Record<string, unknown>)?.['type'];
        if (typeof expectedType !== 'string') continue;
        if (!valueMatchesType(value, expectedType)) {
          return {
            valid: false,
            error: `Input validation failed: property "${key}" must be of type ${expectedType}`,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Execute a tool by name: validate input, then dispatch. Handler throws
   * and validation failures are both converted into ToolResult failures
   * rather than rejecting.
   */
  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool not found: ${name}` };
    }

    const validation = this.validateInput(tool, input);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      return await tool.execute(input, context);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
