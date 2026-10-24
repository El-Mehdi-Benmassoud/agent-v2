import { promises as fsPromises } from 'fs';
import { join } from 'path';
import type { ToolDefinition, ToolContext } from '../types/index.js';
import { ToolCategory } from '../types/index.js';
import { grepTool, globTool } from './fs.js';
import { asRecord, errorMessage, optionalString, requireString, resolvePath } from './shared.js';

// ===========================================================================
// SEARCH tools (3)
// ===========================================================================

const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Unified search: type "content" dispatches to grep, "files" to glob.',
  category: ToolCategory.SEARCH,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      type: { type: 'string' },
      path: { type: 'string' },
      regex: { type: 'boolean' },
      maxResults: { type: 'number' },
    },
    required: ['pattern'],
  },
  async execute(input, context) {
    const rec = asRecord(input);
    const type = optionalString(rec, 'type') ?? 'content';
    if (type === 'content') {
      return grepTool.execute(input, context);
    }
    if (type === 'files') {
      return globTool.execute(input, context);
    }
    return {
      success: false,
      error: `Unknown search type: ${type} (expected "content" or "files")`,
    };
  },
};

const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web (stub until a search backend is configured).',
  category: ToolCategory.SEARCH,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  async execute() {
    return {
      success: false,
      error: 'Web search not configured (set SEARCH_API_KEY to enable)',
    };
  },
};

const WEB_FETCH_TIMEOUT_MS = 15000;
const WEB_FETCH_MAX_BYTES = 1024 * 1024; // 1MB body cap

const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and return the response body as text (15s timeout, 1MB cap).',
  category: ToolCategory.SEARCH,
  requiresApproval: false,
  dangerous: false,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string' },
      headers: { type: 'object' },
      body: { type: 'string' },
    },
    required: ['url'],
  },
  async execute(input) {
    const rec = asRecord(input);
    const url = requireString(rec, 'url');
    const method = (optionalString(rec, 'method') ?? 'GET').toUpperCase();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WEB_FETCH_TIMEOUT_MS);
    try {
      const init: RequestInit = { method, signal: abort.signal, redirect: 'follow' };
      const headers: Record<string, string> = {
        'user-agent': 'agent-v2/0.1 (+https://localhost)',
        accept: 'text/html,application/json;q=0.9,text/*;q=0.8,*/*;q=0.5',
      };
      if (typeof rec['headers'] === 'object' && rec['headers'] !== null && !Array.isArray(rec['headers'])) {
        for (const [key, value] of Object.entries(rec['headers'] as Record<string, unknown>)) {
          if (typeof value === 'string') headers[key] = value;
        }
      }
      init.headers = headers;
      const bodyStr = optionalString(rec, 'body');
      if (bodyStr !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = bodyStr;
      }
      const response = await fetch(url, init);
      let text = '';
      if (method !== 'HEAD') {
        const buf = await response.arrayBuffer();
        const total = Math.min(buf.byteLength, WEB_FETCH_MAX_BYTES);
        text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, total));
        if (buf.byteLength > WEB_FETCH_MAX_BYTES) {
          text += `\n... [truncated at ${WEB_FETCH_MAX_BYTES} bytes of ${buf.byteLength}]`;
        }
      }
      return {
        success: response.ok,
        output: { url, status: response.status, ok: response.ok, text },
        error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
        metadata: { status: response.status },
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  },
};

export const searchTools: ToolDefinition[] = [searchTool, webSearchTool, webFetchTool];
