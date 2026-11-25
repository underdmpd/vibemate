import {
  AdapterInputError,
  AdapterRuntime,
  buildToolMetadata,
  decodeJsonValue,
  optionalRecord,
  readOptionalString,
  readPositiveInteger,
  requireRecord,
  requireString,
  sanitizeErrorSummary,
  sanitizePromptTitle,
  sanitizeReplySummary,
  type AdapterPermissionOutcome,
  type AdapterRuntimeOptions,
} from "@vibemate/adapter-common";
import {
  parseAgentEvent,
  parsePermissionRequest,
  PROTOCOL_VERSION,
  type AgentEvent,
  type PermissionRequest,
  type SessionProblem,
  type UnifiedState,
} from "@vibemate/protocol";

const COPILOT_STATES: Record<string, UnifiedState> = {
  sessionStart: "idle",
  sessionEnd: "ended",
  userPromptSubmitted: "thinking",
  preToolUse: "working",
  postToolUse: "working",
  errorOccurred: "failed",
  agentStop: "completed",
  subagentStart: "working",
  subagentStop: "working",
  preCompact: "working",
};

export type CopilotAdapterResult =
  | { kind: "event"; event: AgentEvent }
  | { kind: "permission"; event: AgentEvent; request: PermissionRequest }
  | { kind: "ignored"; reason: string };

export class CopilotAdapter {
  private readonly runtime: AdapterRuntime;

  constructor(options: AdapterRuntimeOptions = {}) {
    this.runtime = new AdapterRuntime(options);
  }

  adapt(eventName: string, value: unknown): CopilotAdapterResult {
    const payload = requireRecord(value, "Copilot hook payload");
    if (eventName === "permissionRequest") {
      return this.adaptPermission(payload);
    }

    const state = eventName === "notification" && payload.notification_type === "permission_prompt"
      ? "waiting_permission" : COPILOT_STATES[eventName];
    if (!state) {
      return { kind: "ignored", reason: `unsupported Copilot event: ${eventName}` };
    }

    const sessionId = requireString("sessionId", payload.sessionId, payload.session_id);
    const eventId = this.runtime.eventId(payload.eventId, payload.event_id);
    const explicitTurnId = readOptionalString(payload.turnId, payload.turn_id);
    let turnId: string | undefined;
    if (eventName === "userPromptSubmitted") {
      turnId = this.runtime.startTurn("copilot", sessionId, explicitTurnId);
    } else if (eventName === "agentStop") {
      turnId = this.runtime.ensureTurn("copilot", sessionId, explicitTurnId);
    } else {
      turnId = explicitTurnId ?? this.runtime.currentTurn("copilot", sessionId);
    }

    let title: string | undefined;
    let summary: string | undefined;
    let problem: SessionProblem | undefined;
    let recoverable: boolean | undefined;

    if (eventName === "userPromptSubmitted" || eventName === "sessionStart") {
      title = sanitizePromptTitle(payload.prompt, payload.initialPrompt);
    } else if (eventName === "agentStop") {
      summary = sanitizeReplySummary(payload.lastAssistantMessage, payload.last_assistant_message);
    } else if (eventName === "errorOccurred") {
      const errorContext = readOptionalString(payload.errorContext, payload.error_context);
      if (errorContext === "model_call") {
        problem = "api_failed";
      }
      if (typeof payload.recoverable === "boolean") {
        recoverable = payload.recoverable;
      }
      summary = sanitizeErrorSummary(payload.error);
    } else if (eventName === "sessionEnd") {
      const reason = readOptionalString(payload.reason);
      if (reason === "error") {
        problem = "api_failed";
      }
    }

    const toolName = readOptionalString(payload.toolName, payload.tool_name);
    const toolInput = decodeJsonValue(
      payload.toolInput ?? payload.toolArgs ?? payload.tool_input,
    );
    const cwd = this.runtime.cwd(payload.cwd);
    const sourcePid = readPositiveInteger(payload.sourcePid ?? payload.source_pid);

    return {
      kind: "event",
      event: parseAgentEvent({
        protocolVersion: PROTOCOL_VERSION,
        eventId,
        sourceProfile: this.runtime.sourceProfile,
        agent: "copilot",
        sessionId,
        state,
        event: eventName === "notification" ? "permission_prompt" : eventName,
        occurredAt: this.runtime.occurredAt(payload.timestamp ?? payload.occurredAt),
        ...(turnId ? { turnId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(problem ? { problem } : {}),
        ...(recoverable !== undefined ? { recoverable } : {}),
        ...(toolName ? { tool: buildToolMetadata({ name: toolName, input: toolInput }) } : {}),
        ...(sourcePid ? { process: { sourcePid } } : {}),
      }),
    };
  }

  private adaptPermission(payload: Record<string, unknown>): CopilotAdapterResult {
    const sessionId = requireString("sessionId", payload.sessionId, payload.session_id);
    const toolName = requireString("toolName", payload.toolName, payload.tool_name);
    const toolInput = optionalRecord(decodeJsonValue(
      payload.toolInput ?? payload.toolArgs ?? payload.tool_input,
    ));
    if (!toolInput) {
      throw new AdapterInputError("toolInput must be an object");
    }

    const requestId = this.runtime.requestId(payload.requestId, payload.request_id);
    const occurredAt = this.runtime.occurredAt(payload.timestamp ?? payload.occurredAt);
    const tool = buildToolMetadata({ name: toolName, input: toolInput });
    const turnId = this.runtime.ensureTurn(
      "copilot",
      sessionId,
      readOptionalString(payload.turnId, payload.turn_id),
    );
    const cwd = this.runtime.cwd(payload.cwd);

    return {
      kind: "permission",
      request: parsePermissionRequest({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        sourceProfile: this.runtime.sourceProfile,
        agent: "copilot",
        sessionId,
        occurredAt,
        expiresAt: this.runtime.expiresAt(),
        tool,
      }),
      event: parseAgentEvent({
        protocolVersion: PROTOCOL_VERSION,
        eventId: `permission-${requestId}`,
        sourceProfile: this.runtime.sourceProfile,
        agent: "copilot",
        sessionId,
        state: "waiting_permission",
        event: "permissionRequest",
        occurredAt,
        turnId,
        tool,
        ...(cwd ? { cwd } : {}),
      }),
    };
  }
}

export function formatCopilotPermissionOutcome(
  outcome: AdapterPermissionOutcome,
): { statusCode: 200 | 204; body: string } {
  if (outcome.decision === "no_decision") {
    return { statusCode: 204, body: "" };
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      behavior: outcome.decision,
      ...(outcome.decision === "deny" ? { message: "Denied in VibeMate" } : {}),
    }),
  };
}
