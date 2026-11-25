import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAdapter, formatCopilotPermissionOutcome } from "./index.js";

function adapter() {
  let id = 0;
  return new CopilotAdapter({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    generateId: () => `id-${++id}`,
  });
}

test("maps Copilot lifecycle states and supplies completion turn identity", () => {
  const instance = adapter();
  const prompt = instance.adapt("userPromptSubmitted", {
    sessionId: "session-1",
  });
  const stop = instance.adapt("agentStop", {
    sessionId: "session-1",
  });

  assert.equal(prompt.kind, "event");
  assert.equal(stop.kind, "event");
  if (prompt.kind === "event" && stop.kind === "event") {
    assert.equal(prompt.event.state, "thinking");
    assert.equal(stop.event.state, "completed");
    assert.equal(stop.event.turnId, prompt.event.turnId);
  }
});

test("rejects malformed Copilot permission requests instead of blind signing", () => {
  assert.throws(
    () => adapter().adapt("permissionRequest", {
      sessionId: "session-1",
      toolName: "edit",
    }),
    /toolInput must be an object/,
  );
});

test("accepts Copilot toolArgs permission payloads", () => {
  const result = adapter().adapt("permissionRequest", {
    sessionId: "session-1",
    toolName: "edit",
    toolArgs: {
      description: "Edit a file",
      diff: "sensitive diff",
    },
  });

  assert.equal(result.kind, "permission");
  if (result.kind === "permission") {
    assert.equal(result.request.tool.summary, "Edit a file");
    assert.equal("diff" in result.request.tool, false);
  }
});

test("accepts JSON-encoded Copilot toolArgs permission payloads", () => {
  const instance = new CopilotAdapter({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    generateId: () => "generated-id",
  });
  const result = instance.adapt("permissionRequest", {
    sessionId: "session-1",
    requestId: "request-1",
    toolName: "shell",
    toolArgs: JSON.stringify({
      command: "npm test",
      description: "Run tests",
    }),
  });

  assert.equal(result.kind, "permission");
  if (result.kind === "permission") {
    assert.equal(result.request.tool.name, "shell");
    assert.equal(result.request.tool.summary, "Run tests");
    assert.equal(typeof result.request.tool.inputFingerprint, "string");
  }
});

test("Copilot no-decision is an empty 204 response", () => {
  assert.deepEqual(formatCopilotPermissionOutcome({
    requestId: "request-1",
    decision: "no_decision",
    reason: "timeout",
    decidedAt: "2026-08-13T12:00:00.000Z",
  }), {
    statusCode: 204,
    body: "",
  });
});

test("Copilot adapter extracts title, stop summary, and model_call error metadata", () => {
  const instance = adapter();
  const prompt = instance.adapt("userPromptSubmitted", {
    sessionId: "s-meta",
    prompt: "Upgrade nginx config\nwith zero downtime",
    sourcePid: 9876,
  });
  assert.equal(prompt.kind, "event");
  if (prompt.kind === "event") {
    assert.equal(prompt.event.title, "Upgrade nginx config");
    assert.equal(prompt.event.process?.sourcePid, 9876);
  }

  const err = instance.adapt("errorOccurred", {
    sessionId: "s-meta",
    errorContext: "model_call",
    recoverable: true,
    error: { message: "\"Failed native model HTTP request: 502 Bad Gateway\"" },
  });
  assert.equal(err.kind, "event");
  if (err.kind === "event") {
    assert.equal(err.event.problem, "api_failed");
    assert.equal(err.event.recoverable, true);
    assert.equal(err.event.summary, "Failed native model HTTP request: 502 Bad Gateway");
  }

  const stop = instance.adapt("agentStop", {
    sessionId: "s-meta",
    lastAssistantMessage: "Config updated. Reload or restart?",
  });
  assert.equal(stop.kind, "event");
  if (stop.kind === "event") {
    assert.equal(stop.event.summary, "Reload or restart?");
  }
});
