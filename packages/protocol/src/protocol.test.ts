import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionKey,
  parseAgentEvent,
  parsePermissionRequest,
  parseSessionKey,
  sanitizeText,
} from "./index.js";

test("session keys isolate source, agent, and raw session id", () => {
  const codex = createSessionKey({
    sourceProfile: "local",
    agent: "codex",
    sessionId: "same-id",
  });
  const copilot = createSessionKey({
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "same-id",
  });
  const remote = createSessionKey({
    sourceProfile: "remote_a",
    agent: "codex",
    sessionId: "same-id",
  });

  assert.notEqual(codex, copilot);
  assert.notEqual(codex, remote);
  assert.deepEqual(parseSessionKey(codex), {
    sourceProfile: "local",
    agent: "codex",
    sessionId: "same-id",
  });
});

test("event schema rejects unknown and sensitive-looking fields", () => {
  assert.throws(() => parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    state: "working",
    event: "PreToolUse",
    occurredAt: "2026-08-13T12:00:00.000Z",
    prompt: "must not be accepted",
  }));
});

test("completed events require a turn id", () => {
  assert.throws(() => parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-1",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-1",
    state: "completed",
    event: "agentStop",
    occurredAt: "2026-08-13T12:00:00.000Z",
  }));
});

test("permission expiry must be later than creation", () => {
  assert.throws(() => parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T11:59:00.000Z",
    tool: { name: "shell" },
  }));
});

test("sanitizer removes controls, bounds text, and collapses whitespace", () => {
  assert.equal(
    sanitizeText("  run\u0000   npm test  ", { maxLength: 12 }),
    "run npm test",
  );
  assert.equal(
    sanitizeText("abcdefghijk", { maxLength: 8 }),
    "abcdefg…",
  );
});

test("schema sanitizes bounded display metadata", () => {
  const parsed = parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-2",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    state: "working",
    event: " PreToolUse\u0000 ",
    occurredAt: "2026-08-13T12:00:00.000Z",
    tool: {
      name: " shell\u0007 ",
      summary: " run\n  tests ",
    },
  });

  assert.equal(parsed.event, "PreToolUse");
  assert.deepEqual(parsed.tool, {
    name: "shell",
    summary: "run tests",
  });
});

test("bounded parsing rejects non-JSON values clearly", () => {
  assert.throws(
    () => parseAgentEvent(undefined),
    /payload must be a JSON value/,
  );
});

test("event schema accepts bounded redacted title, summary, and problem", () => {
  const parsed = parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-meta",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    state: "failed",
    event: "PostModelRequest",
    occurredAt: "2026-08-13T12:00:00.000Z",
    title: "Fix auth token Bearer eyJhbGciOiJIUzI1NiJ9.abcdef1234567890.sig1234567890123456",
    summary: "400 Bad Request api_key=sk-proj-1234567890abcdefghijklmnop",
    problem: "api_failed",
  });

  assert.equal(parsed.problem, "api_failed");
  assert.equal(parsed.title?.includes("eyJhbGci"), false);
  assert.equal(parsed.summary?.includes("sk-proj-"), false);
  assert.ok((parsed.title?.length ?? 0) <= 60);
  assert.ok((parsed.summary?.length ?? 0) <= 120);
});
