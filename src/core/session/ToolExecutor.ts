import type { Message, ToolDefinition, ToolResult } from '../../types/index.js';
import { ContentType, MessageRole, PermissionMode, ToolCategory, ToolResultContent, ToolUseContent } from '../../types/index.js';
import type { ApprovalCallback, ApprovalRequest } from './types.js';
import type { HookConfig } from '../../types/index.js';
import { HookType } from '../../types/index.js';
import type { HookDecision, HookOutcome } from '../hooks/HookRunner.js';

export interface ToolExecutionOutcome {
  result: ToolResult;
  /** The TOOL-role message carrying the result (for history insertion). */
  message: Message;
  approved: boolean;
}

/** Injectable PRE/POST_TOOL_USE hook driver (tests pass a fake). */
export type HookDriver = {
  runPreToolUse: (toolName: string, input: unknown) => Promise<HookDecision>;
  runPostToolUse: (toolName: string, result: ToolResult) => Promise<HookOutcome[]>;
};

export interface ToolExecutorDeps {
  /** Invoked in DEFAULT mode to ask the user. Optional. */
  requestApproval?: ApprovalCallback;
  /**
   * Emit 'approvalRequested' to attached listeners. Returns the number of
   * listeners the request was delivered to (0 = nobody listening).
   */
  emitApprovalRequest?: (request: ApprovalRequest) => number;
}

export type PermissionDecision = 'approve' | 'deny' | 'ask';

const PLAN_MODE_ERROR =
  'Plan mode is active: tool execution is disabled. No tools may run while planning.';

const NO_LISTENER_ERROR =
  'Tool requires approval, but no approval listener or callback is attached; denied automatically.';

/**
 * Executes ToolDefinition.execute() under the session's permission mode.
 * There is no separate handler map: the execute() function is embedded in
 * the ToolDefinition itself and is invoked as tool.execute(input, context).
 *
 * Modes:
 *  - PLAN        : refuse every tool with a clear error result.
 *  - ACCEPT_EDITS: auto-approve FILE_SYSTEM tools; ask for anything that
 *                  would need approval otherwise.
 *  - AUTO        : approve everything except tools marked dangerous.
 *  - BYPASS      : approve everything, dangerous included.
 *  - DONT_ASK    : never ask — deny anything that would require asking
 *                  (i.e. anything marked requiresApproval or dangerous).
 *  - DEFAULT     : ask via the injected async approval callback and/or the
 *                  'approvalRequested' event. If nobody is listening and no
 *                  callback is wired, deny immediately with a clear error —
 *                  the approval promise must never hang.
 */
export class ToolExecutor {
  private readonly deps: ToolExecutorDeps;
  private readonly hookDriver: HookDriver | null;

  constructor(deps: ToolExecutorDeps = {}, hookDriver: HookDriver | null = null) {
    this.deps = deps;
    this.hookDriver = hookDriver;
  }

  /** Decide whether a tool call is auto-approved, auto-denied, or must ask. */
  static decide(mode: PermissionMode, tool: ToolDefinition): PermissionDecision {
    const needsApproval = tool.requiresApproval === true || tool.dangerous === true;

    switch (mode) {
      case PermissionMode.PLAN:
        return 'deny';
      case PermissionMode.BYPASS:
        return 'approve';
      case PermissionMode.AUTO:
        return tool.dangerous === true ? 'ask' : 'approve';
      case PermissionMode.ACCEPT_EDITS:
        // File edits are auto-approved; everything else follows normal rules.
        if (tool.category === ToolCategory.FILE_SYSTEM) return 'approve';
        return needsApproval ? 'ask' : 'approve';
      case PermissionMode.DONT_ASK:
        // Never interrupt the user: deny whatever would have to ask.
        return needsApproval ? 'deny' : 'approve';
      case PermissionMode.DEFAULT:
      default:
        return needsApproval ? 'ask' : 'approve';
    }
  }

  /**
   * Execute one tool call. The permission mode gates whether execute() is
   * ever invoked; denials produce a failed ToolResult with an explanatory
   * error so the model can react to them.
   */
  async execute(
    tool: ToolDefinition,
    toolUse: ToolUseContent,
    context: {
      workingDirectory: string;
      sessionId: string;
      messageId: string;
      abortSignal: AbortSignal;
      permissionMode: PermissionMode;
    }
  ): Promise<ToolExecutionOutcome> {
    const decision = ToolExecutor.decide(context.permissionMode, tool);

    if (decision === 'deny') {
      const error =
        context.permissionMode === PermissionMode.PLAN
          ? PLAN_MODE_ERROR
          : `Tool '${tool.name}' requires approval, which is denied automatically in ${context.permissionMode} mode.`;
      return {
        result: { success: false, error },
        message: ToolExecutor.buildResultMessage(toolUse, { success: false, error }),
        approved: false,
      };
    }

    if (decision === 'ask') {
      const approval = await this.askPermission(tool, toolUse, context.sessionId);
      if (!approval.approved) {
        const error = approval.reason ?? `Tool '${tool.name}' was not approved.`;
        return {
          result: { success: false, error },
          message: ToolExecutor.buildResultMessage(toolUse, { success: false, error }),
          approved: false,
        };
      }
    }

    // PRE_TOOL_USE hooks may veto the call even after permission was granted.
    if (this.hookDriver) {
      const hookDecision = await this.hookDriver.runPreToolUse(tool.name, toolUse.input);
      if (hookDecision.block === true) {
        const error = hookDecision.reason ?? `Tool '${tool.name}' was blocked by a pre_tool_use hook.`;
        return {
          result: { success: false, error },
          message: ToolExecutor.buildResultMessage(toolUse, { success: false, error }),
          approved: false,
        };
      }
    }

    if (context.abortSignal.aborted) {
      const error = 'Tool execution was aborted before it started.';
      return {
        result: { success: false, error },
        message: ToolExecutor.buildResultMessage(toolUse, { success: false, error }),
        approved: true,
      };
    }

    let result: ToolResult;
    try {
      result = await tool.execute(toolUse.input, {
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        messageId: context.messageId,
        abortSignal: context.abortSignal,
      });
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // POST_TOOL_USE hooks observe results (logging, metrics); they cannot
    // veto, but a failed hook must not corrupt the tool result.
    if (this.hookDriver) {
      try {
        await this.hookDriver.runPostToolUse(tool.name, result);
      } catch {
        // Hook failures are non-fatal by design.
      }
    }

    return {
      result,
      message: ToolExecutor.buildResultMessage(toolUse, result),
      approved: true,
    };
  }

  /**
   * Interactive approval. Emits 'approvalRequested' with resolve handles and
   * optionally awaits an injected async callback; the first answer wins.
   * When no callback exists and the event has no listeners, resolves deny
   * immediately with a clear reason — the promise never hangs.
   */
  private askPermission(
    tool: ToolDefinition,
    toolUse: ToolUseContent,
    sessionId: string
  ): Promise<{ approved: boolean; reason?: string }> {
    const { requestApproval, emitApprovalRequest } = this.deps;

    if (!requestApproval && !emitApprovalRequest) {
      return Promise.resolve({ approved: false, reason: NO_LISTENER_ERROR });
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (approved: boolean, reason?: string): void => {
        if (!settled) {
          settled = true;
          resolve({ approved, reason });
        }
      };

      const request: ApprovalRequest = {
        sessionId,
        toolName: tool.name,
        input: toolUse.input,
        approve: () => settle(true),
        deny: (reason) => settle(false, reason ?? `Tool '${tool.name}' was denied.`),
      };

      // Deliver to event listeners first (the UI's approve/deny handles).
      let listeners = 0;
      if (emitApprovalRequest) {
        listeners = emitApprovalRequest(request);
      }

      if (requestApproval) {
        requestApproval(request)
          .then((approved) => settle(approved, approved ? undefined : `Tool '${tool.name}' was denied.`))
          .catch((err) =>
            settle(false, `Approval callback failed: ${err instanceof Error ? err.message : String(err)}`)
          );
      } else if (listeners === 0) {
        // No callback and nobody listening: deny now rather than hang.
        settle(false, NO_LISTENER_ERROR);
      }
    });
  }

  /** Build the TOOL-role Message wrapping a ToolResult. */
  static buildResultMessage(toolUse: ToolUseContent, result: ToolResult): Message {
    const outputText =
      result.output === undefined
        ? (result.error ?? '')
        : typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output);

    const content: ToolResultContent = {
      type: ContentType.TOOL_RESULT,
      toolUseId: toolUse.id,
      content: outputText,
      isError: !result.success || undefined,
    };

    return {
      role: MessageRole.TOOL,
      content: [content],
      timestamp: new Date(),
      metadata: result.metadata as Message['metadata'],
    };
  }
}
