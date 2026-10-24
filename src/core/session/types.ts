import type {
  Message,
  MessageRole,
  ModelConfig,
  ModelResponse,
  PermissionMode,
  SessionStatus,
  ToolContext,
  ToolDefinition,
  TokenUsage,
  CostBreakdown,
} from '../../types/index.js';

// ============================================================================
// Session Configuration
// ============================================================================

export interface SessionConfig {
  /** Stable identifier for the session. Assigned by SessionManager on create. */
  id: string;
  /** Human-readable title. */
  title?: string;
  /** Model configuration for this session. */
  model: ModelConfig;
  /** Working directory tools operate in. */
  workingDirectory: string;
  /** Permission mode governing tool approval. */
  permissionMode: PermissionMode;
  /** System prompt; if omitted a default is used. */
  systemPrompt?: string;
  /** Hard cap on model round-trips per sendMessage call. */
  maxTurns: number;
  /** Hard cap on cumulative spend per sendMessage call (USD). */
  maxBudgetUsd: number;
  /** Creation timestamp (ISO string). */
  createdAt: string;
  /** Last-update timestamp (ISO string). */
  updatedAt: string;
}

export interface SessionRuntimeConfig {
  model?: Partial<ModelConfig>;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  title?: string;
  workingDirectory?: string;
}

// ============================================================================
// Session State
// ============================================================================

export interface SessionState {
  config: SessionConfig;
  status: SessionStatus;
  messages: Message[];
  /** Monotonic turn counter across the session lifetime. */
  turnCount: number;
  /** Cumulative cost across the session lifetime (USD). */
  totalCostUsd: number;
  /** Cumulative token usage across the session lifetime. */
  totalUsage: TokenUsage;
  /** Controller for the in-flight turn, if any. */
  abortController: AbortController;
  /** True when a turn is currently executing. */
  busy: boolean;
  /** Last assistant response (for UI convenience). */
  lastResponse?: ModelResponse;
}

// ============================================================================
// Send-message options
// ============================================================================

export interface SendMessageOptions {
  /** Stream the response (default: false — one-shot completion). */
  stream?: boolean;
  /** Override per-call system prompt. */
  systemPrompt?: string;
  /** Override permission mode for this call only. */
  permissionMode?: PermissionMode;
  /** Override max turns for this call only. */
  maxTurns?: number;
  /** Override budget for this call only. */
  maxBudgetUsd?: number;
  /** Tools available during this call (overrides session default). */
  tools?: ToolDefinition[];
  /** Working directory for tool execution during this call. */
  workingDirectory?: string;
  /** Model options passed through to the provider. */
  modelOptions?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
    thinkingBudget?: number;
    stopSequences?: string[];
  };
}

// ============================================================================
// Turn result
// ============================================================================

export interface TurnResult {
  /** The final assistant message that terminated the turn. */
  response: ModelResponse;
  /** Number of model round-trips in this turn. */
  turns: number;
  /** Total cost accrued during this turn (USD). */
  costUsd: number;
  /** Total token usage accrued during this turn. */
  usage: TokenUsage;
  /** Cost breakdown for the final model call. */
  costBreakdown?: CostBreakdown;
  /** True if the turn was terminated by abort(). */
  aborted: boolean;
  /** True if the turn hit the budget cap. */
  budgetExceeded: boolean;
  /** True if the turn hit the maxTurns cap. */
  maxTurnsReached: boolean;
}

// ============================================================================
// Approval request (emitted via 'approvalRequested')
// ============================================================================

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  input: unknown;
  /** Call to approve the tool call. */
  approve: () => void;
  /** Call to deny the tool call with a reason. */
  deny: (reason?: string) => void;
}

// ============================================================================
// Event payloads
// ============================================================================

export interface SessionEventPayloads {
  sessionCreated: { sessionId: string; config: SessionConfig };
  messageAdded: { sessionId: string; message: Message };
  turnStart: { sessionId: string; turnNumber: number };
  turnEnd: { sessionId: string; turnNumber: number; result: TurnResult };
  toolStart: { sessionId: string; toolName: string; toolUseId: string; input: unknown };
  toolComplete: {
    sessionId: string;
    toolName: string;
    toolUseId: string;
    success: boolean;
    output?: unknown;
    error?: string;
  };
  toolError: { sessionId: string; toolName: string; toolUseId: string; error: string };
  approvalRequested: ApprovalRequest;
  streamDelta: { sessionId: string; delta: string };
  thinking: { sessionId: string; delta: string };
  error: { sessionId: string; error: string };
  budgetExceeded: { sessionId: string; used: number; limit: number };
  maxTurnsReached: { sessionId: string; maxTurns: number };
  compactionStart: { sessionId: string; messageCount: number };
  compactionComplete: { sessionId: string; beforeCount: number; afterCount: number };
}

export type SessionEventName = keyof SessionEventPayloads;

// ============================================================================
// Persistence shapes (SessionStore)
// ============================================================================

export interface SessionMeta {
  config: SessionConfig;
  status: SessionStatus;
  turnCount: number;
  totalCostUsd: number;
  totalUsage: TokenUsage;
  savedAt: string;
}

export interface PersistedSession {
  meta: SessionMeta;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title?: string;
  status: SessionStatus;
  messageCount: number;
  turnCount: number;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Approval plumbing
// ============================================================================

/** Resolves an approval request. */
export type ApprovalResolver = (approved: boolean, reason?: string) => void;

/** Async approval callback used by DEFAULT permission mode. */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<boolean>;

export type { Message, MessageRole, ToolContext, ToolDefinition, PermissionMode, SessionStatus };
