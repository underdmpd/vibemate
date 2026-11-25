import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentEvent,
  parsePermissionDecision,
  parsePermissionRequest,
} from "@vibemate/protocol";
import { PermissionBroker, SessionStore } from "./index.js";

function event(overrides: Record<string, unknown> = {}) {
  return parseAgentEvent({
    protocolVersion: 1,
    eventId: "event-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    state: "working",
    event: "PreToolUse",
    occurredAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  });
}

test("session store isolates agents with the same raw session id", () => {
  const store = new SessionStore();
  store.apply(event());
  store.apply(event({
    eventId: "event-2",
    agent: "copilot",
    state: "thinking",
    event: "userPromptSubmitted",
  }));

  assert.equal(store.list().length, 2);
});

test("Copilot's startup hook cannot hide the first prompt, including equal timestamps", () => {
  const prompt = event({ agent: "copilot", eventId: "a", event: "userPromptSubmitted", state: "thinking" });
  const start = event({ agent: "copilot", eventId: "z", event: "sessionStart", state: "idle" });
  for (const sequence of [[start, prompt], [prompt, start], [prompt, { ...start, occurredAt: "2026-08-13T12:00:01.000Z" }]]) {
    const store = new SessionStore();
    for (const item of sequence) store.apply(item);
    assert.equal(store.list()[0]?.state, "thinking");
    assert.equal(store.list()[0]?.recentEvents.length, 2);
  }
});

test("event ids are deduplicated inside their session namespace", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event()).result, "applied");
  assert.equal(store.apply(event({
    agent: "copilot",
    state: "thinking",
    event: "userPromptSubmitted",
  })).result, "applied");

  const snapshots = store.list();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every((snapshot) => snapshot.recentEvents.length === 1), true);
});

test("completion preserves the prompt tab only for the same terminal window", () => {
  const store = new SessionStore();
  store.apply(event({ event: "UserPromptSubmit", state: "thinking" }), "123:456:789:0");
  const completion = event({
    eventId: "done", event: "Stop", state: "completed", turnId: "turn-1", occurredAt: "2026-08-13T12:00:01.000Z",
  });
  assert.equal(store.apply(completion, "123:456:789").session?.terminalTarget, "123:456:789:0");
  assert.equal(store.apply(event({
    eventId: "moved", occurredAt: "2026-08-13T12:00:02.000Z",
  }), "123:456:790").session?.terminalTarget, "123:456:790");
});

test("session store ignores duplicate and stale events deterministically", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event()).result, "applied");
  assert.equal(store.apply(event()).result, "duplicate_event");
  assert.equal(store.apply(event({
    eventId: "event-0",
    state: "thinking",
    event: "UserPromptSubmit",
    occurredAt: "2026-08-13T11:59:00.000Z",
  })).result, "stale");

  const snapshot = store.list()[0];
  assert.equal(snapshot?.state, "working");
});

test("session store orders timestamps by instant rather than offset text", () => {
  const store = new SessionStore();
  store.apply(event({
    occurredAt: "2026-08-14T01:00:00.000Z",
  }));
  assert.equal(store.apply(event({
    eventId: "event-2",
    state: "completed",
    event: "Stop",
    turnId: "turn-1",
    occurredAt: "2026-08-13T23:00:00.000-05:00",
  })).result, "applied");
  assert.equal(store.list()[0]?.state, "completed");
});

test("session store emits at most one completion per turn", () => {
  const store = new SessionStore();
  assert.equal(store.apply(event({
    eventId: "complete-1",
    state: "completed",
    event: "Stop",
    turnId: "turn-1",
  })).result, "applied");
  assert.equal(store.apply(event({
    eventId: "complete-2",
    state: "completed",
    event: "agentStop",
    turnId: "turn-1",
    occurredAt: "2026-08-13T12:00:01.000Z",
  })).result, "duplicate_completion");
});

test("session store notifies subscribers when its visible snapshot changes", () => {
  const store = new SessionStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.apply(event());
  store.apply(event());
  store.apply(event({
    eventId: "event-0",
    occurredAt: "2026-08-13T11:59:00.000Z",
  }));
  unsubscribe();
  store.apply(event({
    eventId: "event-2",
    occurredAt: "2026-08-13T12:01:00.000Z",
  }));

  assert.equal(notifications, 2);
});

test("session store tracks startedAt, title, summary, api_timeout only in model wait, and process_exited", () => {
  const store = new SessionStore();
  store.apply(event({
    eventId: "e1",
    state: "thinking",
    event: "UserPromptSubmit",
    occurredAt: "2026-08-13T12:00:00.000Z",
    title: "Fix flaky tests",
    process: { sourcePid: 5555 },
  }));
  assert.equal(store.list()[0]?.startedAt, "2026-08-13T12:00:00.000Z");
  assert.equal(store.list()[0]?.title, "Fix flaky tests");

  // During PreToolUse (tool execution), model-wait timeout must NOT fire even after 1 hour.
  store.apply(event({
    eventId: "e2",
    state: "working",
    event: "PreToolUse",
    occurredAt: "2026-08-13T12:00:05.000Z",
  }));
  assert.equal(store.evaluateHealth({
    nowMs: Date.parse("2026-08-13T13:30:00.000Z"),
    apiTimeoutMs: 360_000,
    isProcessAlive: () => true,
  }), 0);
  assert.equal(store.list()[0]?.problem, undefined);

  // Entering PreModelRequest starts the model-wait timer.
  store.apply(event({
    eventId: "e3",
    state: "thinking",
    event: "PreModelRequest",
    occurredAt: "2026-08-13T12:05:00.000Z",
  }));
  assert.equal(store.evaluateHealth({
    nowMs: Date.parse("2026-08-13T12:11:00.000Z"),
    apiTimeoutMs: 360_000,
    isProcessAlive: () => true,
  }), 1);
  assert.equal(store.list()[0]?.problem, "api_timeout");

  // Next turn clears problem and checks process liveness.
  store.apply(event({
    eventId: "e4",
    state: "thinking",
    event: "UserPromptSubmit",
    occurredAt: "2026-08-13T12:12:00.000Z",
    title: "Second turn",
  }));
  assert.equal(store.list()[0]?.problem, undefined);
  assert.equal(store.evaluateHealth({
    nowMs: Date.parse("2026-08-13T12:12:05.000Z"),
    apiTimeoutMs: 360_000,
    isProcessAlive: (pid) => pid !== 5555,
  }), 1);
  assert.equal(store.list()[0]?.problem, "process_exited");
});

test("session store debounces recoverable api failures and preserves api_failed on SessionEnd", () => {
  const store = new SessionStore({ recoverableApiFailureThreshold: 3 });
  store.apply(event({
    eventId: "r1",
    agent: "copilot",
    state: "thinking",
    event: "userPromptSubmitted",
    occurredAt: "2026-08-13T12:00:00.000Z",
  }));
  // First two recoverable retries stay running without alarming.
  store.apply(event({
    eventId: "r2",
    agent: "copilot",
    state: "failed",
    event: "errorOccurred",
    problem: "api_failed",
    recoverable: true,
    summary: "502 Bad Gateway",
    occurredAt: "2026-08-13T12:00:01.000Z",
  }));
  assert.equal(store.list()[0]?.state, "thinking");
  assert.equal(store.list()[0]?.problem, undefined);

  // If sessionEnd(reason=error) arrives after recoverable failure, escalate to api_failed.
  store.apply(event({
    eventId: "r3",
    agent: "copilot",
    state: "ended",
    event: "sessionEnd",
    problem: "api_failed",
    occurredAt: "2026-08-13T12:00:05.000Z",
  }));
  assert.equal(store.list()[0]?.state, "failed");
  assert.equal(store.list()[0]?.problem, "api_failed");
  assert.equal(store.list()[0]?.summary, "502 Bad Gateway");

  // Hard Codex failure followed by SessionEnd preserves api_failed.
  store.apply(event({
    eventId: "c1",
    agent: "codex",
    sessionId: "s-codex",
    state: "failed",
    event: "PostModelRequest",
    problem: "api_failed",
    summary: "400 invalid_request",
    occurredAt: "2026-08-13T12:01:00.000Z",
  }));
  store.apply(event({
    eventId: "c2",
    agent: "codex",
    sessionId: "s-codex",
    state: "ended",
    event: "SessionEnd",
    occurredAt: "2026-08-13T12:01:01.000Z",
  }));
  const codexSession = store.list().find((s) => s.sessionId === "s-codex");
  assert.equal(codexSession?.state, "failed");
  assert.equal(codexSession?.problem, "api_failed");
  assert.equal(codexSession?.summary, "400 invalid_request");
});

test("permission broker accepts only a matching first decision", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });

  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell", summary: "Run tests" },
  });
  const outcomePromise = broker.waitForDecision(request);

  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:06.000Z",
  })), "identity_mismatch");

  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    decision: "deny",
    decidedAt: "2026-08-13T12:00:07.000Z",
  })), "accepted");

  assert.deepEqual(await outcomePromise, {
    requestId: "request-1",
    decision: "deny",
    decidedAt: "2026-08-13T12:00:07.000Z",
  });
  assert.equal(broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: "request-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    decision: "allow",
    decidedAt: "2026-08-13T12:00:08.000Z",
  })), "already_finalized");
});

test("permission broker notifies subscribers when pending requests change", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const pendingCounts: number[] = [];
  const unsubscribe = broker.subscribe(() => {
    pendingCounts.push(broker.listPending().length);
  });
  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-notify",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });

  const outcome = broker.waitForDecision(request);
  broker.submitDecision(parsePermissionDecision({
    protocolVersion: 1,
    requestId: request.requestId,
    sourceProfile: request.sourceProfile,
    agent: request.agent,
    sessionId: request.sessionId,
    decision: "allow",
    decidedAt: "2026-08-13T12:00:06.000Z",
  }));
  await outcome;
  unsubscribe();

  assert.deepEqual(pendingCounts, [1, 0]);
});

test("permission broker isolates equal request ids across sessions", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const base = {
    protocolVersion: 1 as const,
    requestId: "shared-request",
    sourceProfile: "local",
    agent: "codex" as const,
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  };
  const first = parsePermissionRequest({ ...base, sessionId: "session-1" });
  const second = parsePermissionRequest({ ...base, sessionId: "session-2" });
  const firstOutcome = broker.waitForDecision(first);
  const secondOutcome = broker.waitForDecision(second);

  for (const request of [first, second]) {
    assert.equal(broker.submitDecision(parsePermissionDecision({
      protocolVersion: 1,
      requestId: request.requestId,
      sourceProfile: request.sourceProfile,
      agent: request.agent,
      sessionId: request.sessionId,
      decision: "allow",
      decidedAt: "2026-08-13T12:00:06.000Z",
    })), "accepted");
  }

  assert.equal((await firstOutcome).decision, "allow");
  assert.equal((await secondOutcome).decision, "allow");
});

test("permission broker resolves no decision on shutdown", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
  });
  const request = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-2",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-2",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });
  const outcomePromise = broker.waitForDecision(request);

  assert.equal(broker.shutdown(), 1);
  assert.deepEqual(await outcomePromise, {
    requestId: "request-2",
    decision: "no_decision",
    reason: "shutdown",
    decidedAt: "2026-08-13T12:00:05.000Z",
  });

  const afterShutdown = await broker.waitForDecision(parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-3",
    sourceProfile: "local",
    agent: "copilot",
    sessionId: "session-2",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  }));
  assert.equal(afterShutdown.decision, "no_decision");
  assert.equal("reason" in afterShutdown && afterShutdown.reason, "shutdown");
});

test("permission broker expires requests without an external sweep", async () => {
  const broker = new PermissionBroker();
  const now = Date.now();
  const outcome = await broker.waitForDecision(parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-auto-expire",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: new Date(now - 10).toISOString(),
    expiresAt: new Date(now + 30).toISOString(),
    tool: { name: "shell" },
  }));

  assert.equal(outcome.decision, "no_decision");
  assert.equal("reason" in outcome && outcome.reason, "timeout");
});

test("permission broker fails safely when pending capacity is exhausted", async () => {
  const broker = new PermissionBroker({
    now: () => new Date("2026-08-13T12:00:05.000Z"),
    maxPendingRequests: 1,
  });
  const first = parsePermissionRequest({
    protocolVersion: 1,
    requestId: "request-capacity-1",
    sourceProfile: "local",
    agent: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T12:00:00.000Z",
    expiresAt: "2026-08-13T12:01:00.000Z",
    tool: { name: "shell" },
  });
  const second = parsePermissionRequest({
    ...first,
    requestId: "request-capacity-2",
  });

  void broker.waitForDecision(first);
  const outcome = await broker.waitForDecision(second);
  assert.equal(outcome.decision, "no_decision");
  assert.equal("reason" in outcome && outcome.reason, "broker_capacity");
  broker.shutdown();
});
