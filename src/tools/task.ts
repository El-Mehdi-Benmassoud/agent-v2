import { createHash, randomUUID } from 'crypto';
import type { ToolDefinition, ToolResult } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { asRecord, errorMessage, requireString } from './shared.js';

// ===========================================================================
// TASK tools (2)
// ===========================================================================

// --- task: stub with a sha256-derived task id (sub-agent runtime comes later)

const taskTool: ToolDefinition = {
  name: 'task',
  description: 'Create a sub-agent task (stub: returns a derived task id and "created" status).',
  category: ToolCategory.TASK,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
      agent: { type: 'string' },
    },
    required: ['description'],
  },
  async execute(input) {
    const rec = asRecord(input);
    const description = requireString(rec, 'description');
    const prompt = typeof rec['prompt'] === 'string' ? rec['prompt'] : description;
    const agent = typeof rec['agent'] === 'string' ? rec['agent'] : 'default';
    const seed = createHash('sha256').update(`${agent}:${description}:${prompt}`).digest('hex');
    const taskId = `task-${seed.slice(0, 12)}`;
    return {
      success: true,
      output: {
        taskId,
        status: 'created',
        agent,
        description,
      },
      metadata: { taskId, status: 'created' },
    };
  },
};

// --- todo: in-memory session-scoped todo list

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
  updatedAt: string;
}

const todosBySession = new Map<string, TodoItem[]>();

function sessionTodos(sessionId: string): TodoItem[] {
  const existing = todosBySession.get(sessionId);
  if (existing !== undefined) return existing;
  const created: TodoItem[] = [];
  todosBySession.set(sessionId, created);
  return created;
}

function nowIso(): string {
  return new Date().toISOString();
}

const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage a session todo list: add, update, complete, remove, list, or clear.',
  category: ToolCategory.TASK,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      id: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['action'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const action = requireString(rec, 'action');
    const list = sessionTodos(context.sessionId);
    try {
      switch (action) {
        case 'add': {
          const content = requireString(rec, 'content');
          const item: TodoItem = {
            id: randomUUID(),
            content,
            status: 'pending',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          list.push(item);
          return { success: true, output: { item }, metadata: { count: list.length } };
        }
        case 'update': {
          const id = requireString(rec, 'id');
          const idx = list.findIndex((t) => t.id === id);
          if (idx === -1) return { success: false, error: `Todo not found: ${id}` };
          const current = list[idx];
          if (current === undefined) return { success: false, error: `Todo not found: ${id}` };
          const content = typeof rec['content'] === 'string' ? rec['content'] : current.content;
          const status =
            rec['status'] === 'pending' || rec['status'] === 'in_progress' || rec['status'] === 'completed'
              ? rec['status']
              : current.status;
          const updated: TodoItem = { ...current, content, status, updatedAt: nowIso() };
          list[idx] = updated;
          return { success: true, output: { item: updated } };
        }
        case 'complete': {
          const id = requireString(rec, 'id');
          const current = list.find((t) => t.id === id);
          if (current === undefined) return { success: false, error: `Todo not found: ${id}` };
          current.status = 'completed';
          current.updatedAt = nowIso();
          return { success: true, output: { item: current } };
        }
        case 'remove': {
          const id = requireString(rec, 'id');
          const idx = list.findIndex((t) => t.id === id);
          if (idx === -1) return { success: false, error: `Todo not found: ${id}` };
          const removed = list.splice(idx, 1)[0];
          return { success: true, output: { removed } };
        }
        case 'list': {
          return { success: true, output: { todos: list }, metadata: { count: list.length } };
        }
        case 'clear': {
          list.length = 0;
          return { success: true, output: { cleared: true } };
        }
        default:
          return {
            success: false,
            error: `Unknown todo action: ${action} (expected add, update, complete, remove, list, or clear)`,
          };
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  },
};

export const taskTools: ToolDefinition[] = [taskTool, todoTool];
