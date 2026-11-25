import { AdapterRuntime, requireRecord, requireString, sanitizePromptTitle, sanitizeReplySummary, sanitizeErrorSummary } from "@vibemate/adapter-common";
import { parseAgentEvent, type UnifiedState } from "@vibemate/protocol";

const states: Record<string, UnifiedState> = {
  SessionStart: "idle", SessionEnd: "ended", UserPromptSubmit: "thinking",
  PreInvocation: "thinking", PostInvocation: "working", PreToolUse: "working",
  PostToolUse: "working", Stop: "completed", StopFailure: "failed",
};

export function adaptMonitorEvent(runtime: AdapterRuntime, agent: "claude" | "antigravity", name: string, value: unknown) {
  const data = requireRecord(value, "monitor hook");
  let state = states[name];
  if (!Object.hasOwn(states, name) || !state) return;
  const google = agent === "antigravity";
  if (google && name === "Stop") {
    if (data.terminationReason === "error" || data.terminationReason === "max_steps_exceeded") state = "failed";
    else if (data.fullyIdle !== true) return;
  }
  const sessionId = requireString("session", google ? data.conversationId : data.session_id);
  const turnId = name === "UserPromptSubmit" || name === "PreInvocation"
    ? runtime.startTurn(agent, sessionId) : runtime.ensureTurn(agent, sessionId);
  const cwd = runtime.cwd(google && Array.isArray(data.workspacePaths) ? data.workspacePaths[0] : data.cwd);
  return parseAgentEvent({
    protocolVersion: 1, agent, sessionId, turnId, state, event: name, sourceProfile: runtime.sourceProfile,
    eventId: runtime.eventId(), occurredAt: runtime.occurredAt(undefined), cwd,
    title: sanitizePromptTitle(google ? data.lastUserInput : data.prompt),
    summary: state === "failed" ? sanitizeErrorSummary(data.error_details ?? data.error) : sanitizeReplySummary(data.last_assistant_message),
  });
}
