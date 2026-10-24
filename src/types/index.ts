import { z } from 'zod';

// ============================================================================
// Provider Types
// ============================================================================

export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  CODEX = 'codex',
  OLLAMA = 'ollama',
  CUSTOM = 'custom',
}

export enum ModelId {
  // Anthropic
  CLAUDE_OPUS_4 = 'claude-opus-4-20250514',
  CLAUDE_SONNET_4 = 'claude-sonnet-4-20250514',
  CLAUDE_3_5_SONNET = 'claude-3-5-sonnet-20241022',
  CLAUDE_3_5_HAIKU = 'claude-3-5-haiku-20241022',
  CLAUDE_3_OPUS = 'claude-3-opus-20240229',
  CLAUDE_3_SONNET = 'claude-3-sonnet-20240229',
  CLAUDE_3_HAIKU = 'claude-3-haiku-20240307',
  // OpenAI
  GPT_4O = 'gpt-4o',
  GPT_4O_MINI = 'gpt-4o-mini',
  GPT_4_TURBO = 'gpt-4-turbo',
  GPT_4 = 'gpt-4',
  GPT_3_5_TURBO = 'gpt-3.5-turbo',
  O1_PREVIEW = 'o1-preview',
  O1_MINI = 'o1-mini',
  O3_MINI = 'o3-mini',
  // Google
  GEMINI_1_5_PRO = 'gemini-1.5-pro',
  GEMINI_1_5_FLASH = 'gemini-1.5-flash',
  GEMINI_1_5_PRO_LATEST = 'gemini-1.5-pro-latest',
  GEMINI_1_5_FLASH_LATEST = 'gemini-1.5-flash-latest',
  GEMINI_2_0_FLASH_EXP = 'gemini-2.0-flash-exp',
  GEMINI_2_0_PRO_EXP = 'gemini-2.0-pro-exp',
  // Custom
  CUSTOM = 'custom',
}

export interface ModelConfig {
  provider: ModelProvider;
  modelId: ModelId | string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: ModelConfig;
}

// Zod schemas for provider types
export const ModelProviderSchema = z.nativeEnum(ModelProvider);
export const ModelIdSchema = z.nativeEnum(ModelId).or(z.string());

export const ModelConfigSchema: z.ZodType<ModelConfig> = z.lazy(() =>
  z.object({
    provider: ModelProviderSchema,
    modelId: ModelIdSchema,
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    thinkingBudget: z.number().int().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    fallbackModel: ModelConfigSchema.optional(),
  })
);

// ============================================================================
// Session Types
// ============================================================================

export enum SessionStatus {
  INITIALIZING = 'initializing',
  ACTIVE = 'active',
  RUNNING_TOOL = 'running_tool',
  WAITING_FOR_APPROVAL = 'waiting_for_approval',
  WAITING_FOR_INPUT = 'waiting_for_input',
  COMPACTING = 'compacting',
  COMPLETED = 'completed',
  ERROR = 'error',
}

export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

export enum ContentType {
  TEXT = 'text',
  IMAGE = 'image',
  TOOL_USE = 'tool_use',
  TOOL_RESULT = 'tool_result',
  THINKING = 'thinking',
}

// Base content interface
export interface BaseContent {
  type: ContentType;
}

// Text content
export interface TextContent extends BaseContent {
  type: ContentType.TEXT;
  text: string;
  cacheControl?: { type: 'ephemeral' } | { type: 'persistent' };
}

// Image content
export interface ImageContent extends BaseContent {
  type: ContentType.IMAGE;
  source: {
    type: 'base64' | 'url';
    mediaType: string;
    data?: string;
    url?: string;
  };
  cacheControl?: { type: 'ephemeral' } | { type: 'persistent' };
}

// Tool use content
export interface ToolUseContent extends BaseContent {
  type: ContentType.TOOL_USE;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Tool result content
export interface ToolResultContent extends BaseContent {
  type: ContentType.TOOL_RESULT;
  toolUseId: string;
  content: string | TextContent[] | ImageContent[];
  isError?: boolean;
}

// Thinking content (for reasoning models)
export interface ThinkingContent extends BaseContent {
  type: ContentType.THINKING;
  thinking: string;
  signature?: string;
}

export type MessageContent =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;

export interface MessageMetadata {
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  costUsd?: number;
  turnNumber?: number;
  toolUseCount?: number;
}

export interface Message {
  role: MessageRole;
  content: MessageContent[];
  timestamp: Date;
  metadata?: MessageMetadata;
}

// Zod schemas for session types
export const SessionStatusSchema = z.nativeEnum(SessionStatus);
export const MessageRoleSchema = z.nativeEnum(MessageRole);
export const ContentTypeSchema = z.nativeEnum(ContentType);

export const TextContentSchema = z.object({
  type: z.literal(ContentType.TEXT),
  text: z.string(),
  cacheControl: z
    .object({
      type: z.enum(['ephemeral', 'persistent']),
    })
    .optional(),
});

export const ImageContentSchema = z.object({
  type: z.literal(ContentType.IMAGE),
  source: z.object({
    type: z.enum(['base64', 'url']),
    mediaType: z.string(),
    data: z.string().optional(),
    url: z.string().url().optional(),
  }),
  cacheControl: z
    .object({
      type: z.enum(['ephemeral', 'persistent']),
    })
    .optional(),
});

export const ToolUseContentSchema = z.object({
  type: z.literal(ContentType.TOOL_USE),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

export const ToolResultContentSchema = z.object({
  type: z.literal(ContentType.TOOL_RESULT),
  toolUseId: z.string(),
  content: z.union([z.string(), z.array(TextContentSchema), z.array(ImageContentSchema)]),
  isError: z.boolean().optional(),
});

export const ThinkingContentSchema = z.object({
  type: z.literal(ContentType.THINKING),
  thinking: z.string(),
  signature: z.string().optional(),
});

export const MessageContentSchema: z.ZodType<MessageContent> = z.discriminatedUnion('type', [
  TextContentSchema,
  ImageContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
  ThinkingContentSchema,
]);

export const MessageMetadataSchema = z.object({
  model: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheCreationTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  costUsd: z.number().nonnegative().optional(),
  turnNumber: z.number().int().positive().optional(),
  toolUseCount: z.number().int().nonnegative().optional(),
});

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.array(MessageContentSchema),
  timestamp: z.date(),
  metadata: MessageMetadataSchema.optional(),
});

// ============================================================================
// Tool Types
// ============================================================================

export enum ToolCategory {
  FILE_SYSTEM = 'file_system',
  SHELL = 'shell',
  SEARCH = 'search',
  GIT = 'git',
  CODE = 'code',
  TASK = 'task',
  MCP = 'mcp',
  WEB = 'web',
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodSchema | Record<string, unknown>;
  requiresApproval?: boolean;
  dangerous?: boolean;
  execute: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  workingDirectory: string;
  sessionId: string;
  messageId: string;
  approvalCallback?: (toolName: string, input: unknown) => Promise<boolean>;
  progressCallback?: (progress: number, message?: string) => void;
  abortSignal: AbortSignal;
}

// Zod schemas for tool types
export const ToolCategorySchema = z.nativeEnum(ToolCategory);

export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ToolContextSchema = z.object({
  workingDirectory: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  // approvalCallback, progressCallback, abortSignal are functions/symbols - not serializable
});

// ToolDefinitionSchema cannot include the execute function - handled separately
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: ToolCategorySchema,
  inputSchema: z.union([z.instanceof(z.ZodSchema), z.record(z.unknown())]),
  requiresApproval: z.boolean().optional(),
  dangerous: z.boolean().optional(),
  // execute is omitted as it's a function
});

// ============================================================================
// Config Types
// ============================================================================

export enum PermissionMode {
  DEFAULT = 'default',
  ACCEPT_EDITS = 'accept_edits',
  PLAN = 'plan',
  AUTO = 'auto',
  BYPASS = 'bypass',
  DONT_ASK = 'dont_ask',
}

export interface WorkspaceConfig {
  rootPath: string;
  excludedPaths?: string[];
  includedPaths?: string[];
  maxFileSize?: number;
  watchEnabled?: boolean;
}

export interface UiConfig {
  theme: string;
  showTokenUsage: boolean;
  showCost: boolean;
  compactMode: boolean;
  vimMode: boolean;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

export interface SkillsConfig {
  enabled: boolean;
  paths: string[];
  autoLoad: boolean;
}

export interface AgentsConfig {
  enabled: boolean;
  defaultMaxTurns: number;
  defaultMaxBudgetUsd: number;
}

export interface McpServersConfig {
  [serverName: string]: McpServerConfig;
}

export interface Config {
  version: number;
  profile: string;
  model: ModelConfig;
  workspace: WorkspaceConfig;
  permissions: {
    mode: PermissionMode;
    allowedTools?: string[];
    deniedTools?: string[];
    allowCommands?: string[];
    denyCommands?: string[];
  };
  ui: UiConfig;
  hooks: HooksConfig;
  skills: SkillsConfig;
  agents: AgentsConfig;
  mcpServers: McpServersConfig;
}

// Zod schemas for config types
export const PermissionModeSchema = z.nativeEnum(PermissionMode);

export const WorkspaceConfigSchema = z.object({
  rootPath: z.string(),
  excludedPaths: z.array(z.string()).optional(),
  includedPaths: z.array(z.string()).optional(),
  maxFileSize: z.number().int().positive().optional(),
  watchEnabled: z.boolean().optional(),
});

export const UiConfigSchema = z.object({
  theme: z.string().default('default'),
  showTokenUsage: z.boolean().default(true),
  showCost: z.boolean().default(true),
  compactMode: z.boolean().default(false),
  vimMode: z.boolean().default(false),
  showLineNumbers: z.boolean().default(true),
  wrapLongLines: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Hook types (declared early: the config schemas below reference them)
// ---------------------------------------------------------------------------

export enum HookType {
  PRE_TOOL_USE = 'pre_tool_use',
  POST_TOOL_USE = 'post_tool_use',
  PRE_MESSAGE = 'pre_message',
  POST_MESSAGE = 'post_message',
  SESSION_START = 'session_start',
  SESSION_END = 'session_end',
  ERROR = 'error',
  BUDGET_EXCEEDED = 'budget_exceeded',
  TURN_START = 'turn_start',
  TURN_END = 'turn_end',
}

export interface HookConfig {
  type: HookType;
  command: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface HookInput {
  hookType: HookType;
  sessionId: string;
  toolName?: string;
  input?: unknown;
  result?: unknown;
  message?: string;
  turnNumber?: number;
  error?: string;
  extra?: Record<string, unknown>;
}

export interface HooksConfig {
  [hookType: string]: HookConfig[];
}

export const HookTypeSchema = z.nativeEnum(HookType);

export const HookConfigSchema = z.object({
  type: z.string(),
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
});

// Strict variant (enum-typed) — matches the HookConfig interface exactly.
export const HookConfigSchemaZod = z.object({
  type: HookTypeSchema,
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
});

export const HooksConfigSchema = z.record(z.array(HookConfigSchemaZod));

export const SkillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default(['.claude/skills', '~/.claude/skills']),
  autoLoad: z.boolean().default(true),
});

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultMaxTurns: z.number().int().positive().default(50),
  defaultMaxBudgetUsd: z.number().positive().default(10),
});

export const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  transport: z.enum(['stdio', 'sse', 'websocket']).default('stdio'),
});

export const McpServersConfigSchema = z.record(McpServerConfigSchema);

export const PermissionsConfigSchema = z.object({
  mode: PermissionModeSchema.default(PermissionMode.DEFAULT),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  allowCommands: z.array(z.string()).optional(),
  denyCommands: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  profile: z.string().default('default'),
  model: ModelConfigSchema,
  workspace: WorkspaceConfigSchema,
  permissions: PermissionsConfigSchema,
  ui: UiConfigSchema,
  hooks: HooksConfigSchema,
  skills: SkillsConfigSchema,
  agents: AgentsConfigSchema,
  mcpServers: McpServersConfigSchema,
});

// ============================================================================
// MCP Types
// ============================================================================

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse' | 'websocket';
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

// ============================================================================
// Skills Types
// ============================================================================

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  triggers: string[];
  instructions: string;
  examples?: Array<{
    input: string;
    output: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  triggers?: string[];
  tags?: string[];
  author?: string;
  license?: string;
}

// Zod schemas for skills
export const SkillDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  triggers: z.array(z.string()).default([]),
  instructions: z.string(),
  examples: z
    .array(
      z.object({
        input: z.string(),
        output: z.string(),
      })
    )
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  triggers: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  modelConfig?: Partial<ModelConfig>;
  allowedTools?: string[];
  deniedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  workingDirectory?: string;
  env?: Record<string, string>;
  permissionMode?: 'default' | 'plan' | 'accept_edits' | 'auto' | 'bypass' | 'dont_ask';
  task?: string;
}

export interface SubAgentConfig extends AgentConfig {
  parentSessionId: string;
  taskId: string;
  inheritContext?: boolean;
  contextSummary?: string;
}

// ============================================================================
// Sub-Agent Runtime Types
// ============================================================================

export interface SubAgentSessionConfig {
  id: string;
  title: string;
  model: ModelConfig;
  workingDirectory: string;
  permissionMode: 'default' | 'plan' | 'accept_edits' | 'auto' | 'bypass' | 'dont_ask';
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  config: AgentConfig;
  status: 'initializing' | 'active' | 'completed' | 'error' | 'aborted';
  messages: Message[];
  turnCount: number;
  totalCostUsd: number;
  totalUsage: TokenUsage;
  abortController: AbortController;
  busy: boolean;
  sessionConfig?: SubAgentSessionConfig;
}

export interface AgentResult {
  success: boolean;
  output?: unknown;
  error?: string;
  costUsd: number;
  usage: TokenUsage;
  turns: number;
  durationMs: number;
  artifacts?: Record<string, unknown>;
}

// Zod schemas for agents
export const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  modelConfig: z
    .object({
      provider: ModelProviderSchema.optional(),
      modelId: ModelIdSchema.optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
      thinkingBudget: z.number().int().positive().optional(),
      maxTurns: z.number().int().positive().optional(),
      maxBudgetUsd: z.number().positive().optional(),
    })
    .optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  workingDirectory: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export const SubAgentConfigSchema = AgentConfigSchema.extend({
  parentSessionId: z.string(),
  taskId: z.string(),
  inheritContext: z.boolean().optional(),
  contextSummary: z.string().optional(),
});

// ============================================================================
// Hook Types
// ============================================================================

export interface HookContext {
  hookType: HookType;
  sessionId: string;
  messageId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  message?: Message;
  error?: Error;
  timestamp: Date;
}

// Zod schemas for hooks
export const HookContextSchema = z.object({
  hookType: HookTypeSchema,
  sessionId: z.string(),
  messageId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolResult: ToolResultSchema.optional(),
  message: MessageSchema.optional(),
  error: z.instanceof(Error).optional(),
  timestamp: z.date(),
});

// ============================================================================
// Provider Runtime Types
// ============================================================================

export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsSystemPrompt: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  supportedModels: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  costUsd?: number;
}

export interface TokenCountResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  content: MessageContent[];
  usage: TokenUsage;
  stopReason: StopReason;
  modelId: string;
  provider: ModelProvider;
}

export interface ModelStreamChunk {
  type: 'content' | 'tool_use' | 'thinking' | 'usage' | 'error' | 'complete';
  delta?: string;
  content?: MessageContent;
  toolUse?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    partial?: boolean;
  };
  thinking?: string;
  usage?: TokenUsage;
  error?: string;
  stopReason?: StopReason;
}

export interface ModelOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  stopSequences?: string[];
  systemPrompt?: string;
}

export enum StopReason {
  END_TURN = 'end_turn',
  MAX_TOKENS = 'max_tokens',
  STOP_SEQUENCE = 'stop_sequence',
  TOOL_USE = 'tool_use',
  ERROR = 'error',
  BUDGET_EXCEEDED = 'budget_exceeded',
  TURN_LIMIT = 'turn_limit',
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Pricing types
export interface PricingTier {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPricing {
  [modelId: string]: PricingTier;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  currency: 'USD';
  model: string;
  provider: ModelProvider;
}

export interface BudgetStatus {
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  warning: boolean;
  critical: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

// ============================================================================
// Export all schemas as a single registry for validation
// ============================================================================

export const Schemas = {
  ModelProvider: ModelProviderSchema,
  ModelId: ModelIdSchema,
  ModelConfig: ModelConfigSchema,
  SessionStatus: SessionStatusSchema,
  MessageRole: MessageRoleSchema,
  ContentType: ContentTypeSchema,
  TextContent: TextContentSchema,
  ImageContent: ImageContentSchema,
  ToolUseContent: ToolUseContentSchema,
  ToolResultContent: ToolResultContentSchema,
  ThinkingContent: ThinkingContentSchema,
  MessageContent: MessageContentSchema,
  MessageMetadata: MessageMetadataSchema,
  Message: MessageSchema,
  ToolCategory: ToolCategorySchema,
  ToolResult: ToolResultSchema,
  ToolContext: ToolContextSchema,
  ToolDefinition: ToolDefinitionSchema,
  PermissionMode: PermissionModeSchema,
  WorkspaceConfig: WorkspaceConfigSchema,
  UiConfig: UiConfigSchema,
  HookConfig: HookConfigSchema,
  HooksConfig: HooksConfigSchema,
  SkillsConfig: SkillsConfigSchema,
  AgentsConfig: AgentsConfigSchema,
  McpServerConfig: McpServerConfigSchema,
  McpServersConfig: McpServersConfigSchema,
  PermissionsConfig: PermissionsConfigSchema,
  Config: ConfigSchema,
  SkillDefinition: SkillDefinitionSchema,
  SkillFrontmatter: SkillFrontmatterSchema,
  AgentConfig: AgentConfigSchema,
  SubAgentConfig: SubAgentConfigSchema,
  HookType: HookTypeSchema,
  HookConfigZod: HookConfigSchemaZod,
  HookContext: HookContextSchema,
} as const;

export type SchemaRegistry = typeof Schemas;