import assert from "node:assert/strict";
import test from "node:test";
import { CodexAdapter, formatCodexPermissionOutcome } from "./index.js";

function adapter() {
  let id = 0;
  return new CodexAdapter({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    generateId: () => `id-${++id}`,
  });
}

test("maps Codex lifecycle events and keeps one turn identity", () => {
  const instance = adapter();
  const prompt = instance.adapt({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
  });
  const stop = instance.adapt({
    hook_event_name: "Stop",
    session_id: "session-1",
  });

  assert.equal(prompt.kind, "event");
  assert.equal(stop.kind, "event");
  if (prompt.kind === "event" && stop.kind === "event") {
    assert.equal(prompt.event.state, "thinking");
    assert.equal(stop.event.state, "completed");
    assert.equal(stop.event.turnId, prompt.event.turnId);
  }
});

test("Codex permission adaptation retains only bounded metadata", () => {
  const result = adapter().adapt({
    hook_event_name: "PermissionRequest",
    session_id: "session-1",
    tool_name: "Bash",
    tool_input: {
      command: "echo secret",
      description: "Run a command",
    },
  });

  assert.equal(result.kind, "permission");
  if (result.kind === "permission") {
    assert.deepEqual(result.request.tool.name, "Bash");
    assert.equal(result.request.tool.summary, "Run a command");
    assert.equal("command" in result.request.tool, false);
    assert.equal(result.event.state, "waiting_permission");
  }
});

test("Codex permission output uses official decision envelope", () => {
  assert.equal(formatCodexPermissionOutcome({
    requestId: "request-1",
    decision: "no_decision",
    reason: "timeout",
    decidedAt: "2026-08-13T12:00:00.000Z",
  }), "{}");

  assert.deepEqual(JSON.parse(formatCodexPermissionOutcome({
    requestId: "request-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:00.000Z",
  })), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
});

test("Codex adapter extracts bounded title, last reply, and model request failures", () => {
  const instance = adapter();
  const prompt = instance.adapt({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-2",
    prompt: "Fix I2C timeout\nsecond line with lots of detail",
    source_pid: 4242,
  });
  assert.equal(prompt.kind, "event");
  if (prompt.kind === "event") {
    assert.equal(prompt.event.title, "Fix I2C timeout");
    assert.equal(prompt.event.process?.sourcePid, 4242);
  }

  const pre = instance.adapt({ hook_event_name: "PreModelRequest", session_id: "session-2" });
  assert.equal(pre.kind, "event");
  if (pre.kind === "event") assert.equal(pre.event.state, "thinking");

  const fail = instance.adapt({
    hook_event_name: "PostModelRequest",
    session_id: "session-2",
    status: "failed",
    error: JSON.stringify({ error: { type: "invalid_request_error", message: "Copilot rejected the request parameters." } }),
  });
  assert.equal(fail.kind, "event");
  if (fail.kind === "event") {
    assert.equal(fail.event.state, "failed");
    assert.equal(fail.event.problem, "api_failed");
    assert.equal(fail.event.summary, "Copilot rejected the request parameters.");
    assert.equal(fail.event.recoverable, undefined);
  }

  const retryable = instance.adapt({
    hook_event_name: "PostModelRequest",
    session_id: "session-2",
    status: "failed",
    error: "Connection failed: error sending request",
  });
  assert.equal(retryable.kind, "event");
  if (retryable.kind === "event") {
    assert.equal(retryable.event.problem, "api_failed");
    assert.equal(retryable.event.recoverable, true);
  }

  const stop = instance.adapt({
    hook_event_name: "Stop",
    session_id: "session-2",
    last_assistant_message: "First paragraph.\n\nAdded retries. All 12 tests passed.",
  });
  assert.equal(stop.kind, "event");
  if (stop.kind === "event") {
    assert.equal(stop.event.summary, "All 12 tests passed.");
  }
});
