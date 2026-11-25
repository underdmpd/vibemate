import assert from "node:assert/strict";
import test from "node:test";
import type { AggregatedSession, EnvironmentView } from "./environment-types.js";
import { describeNotice, OFFLINE_GRACE_MS, projectName, TaskNotifier } from "./task-notifier.js";

const NOW = Date.parse("2026-11-05T10:00:00.000Z");

function session(
  state: AggregatedSession["state"],
  updatedAt: string,
  cwd?: string,
  extra: Partial<AggregatedSession> = {},
): AggregatedSession {
  return {
    key: "k", sourceProfile: "default", agent: "codex", sessionId: "s1", state, updatedAt,
    recentEvents: cwd ? [{ cwd } as AggregatedSession["recentEvents"][number]] : [],
    deviceId: "d1", environmentId: "e1", environmentName: "树莓派",
    ...extra,
  };
}

function env(status: EnvironmentView["status"], disconnectedAt?: string): EnvironmentView {
  return {
    environmentId: "e1",
    deviceId: "d1",
    name: "树莓派",
    kind: "ssh",
    sshHost: "pi",
    enabled: true,
    status,
    manuallyStarted: false,
    ...(disconnectedAt ? { disconnectedAt } : {}),
  };
}

test("notifies when a running task completes", () => {
  const notifier = new TaskNotifier();
  assert.deepEqual(notifier.diff({ sessions: [session("working", "2026-11-05T09:59:50.000Z")] }, NOW), []);
  const [notice] = notifier.diff({ sessions: [session("completed", "2026-11-05T09:59:58.000Z", "/home/pi/vibemate")] }, NOW);
  assert.equal(notice?.kind, "completed");
  assert.equal(notice?.project, "vibemate");
  assert.deepEqual(describeNotice(notice!), { title: "vibemate 完成了", body: "树莓派 · Codex" });
});

test("notifies on api_failed, api_timeout, process_exited, and 90s offline grace", () => {
  const notifier = new TaskNotifier();
  const [apiErr] = notifier.diff({
    sessions: [session("failed", "2026-11-05T09:59:59.000Z", "/home/pi/app", {
      title: "修 I2C 超时",
      summary: "400 Bad Request",
      problem: "api_failed",
    })],
  }, NOW);
  assert.equal(apiErr?.kind, "api_failed");
  assert.deepEqual(describeNotice(apiErr!), {
    title: "修 I2C 超时 模型请求失败",
    body: "树莓派 · Codex — 400 Bad Request",
  });

  // Offline notification waits the full 90s grace period.
  const running = session("working", "2026-11-05T09:59:00.000Z", "/home/pi/app", { sessionId: "s2" });
  const disconnectTime = new Date(NOW - 30_000).toISOString();
  assert.equal(notifier.diff({ environments: [env("disconnected", disconnectTime)], sessions: [running] }, NOW).length, 0);
  const [offlineNotice] = notifier.diff(
    { environments: [env("disconnected", disconnectTime)], sessions: [running] },
    NOW + OFFLINE_GRACE_MS,
  );
  assert.equal(offlineNotice?.kind, "offline");
  // Same outage does not re-notify.
  assert.equal(notifier.diff(
    { environments: [env("disconnected", disconnectTime)], sessions: [running] },
    NOW + OFFLINE_GRACE_MS + 10_000,
  ).length, 0);
});

test("does not repeat the same state or replay old history on connect", () => {
  const notifier = new TaskNotifier();
  assert.deepEqual(notifier.diff({ sessions: [session("completed", "2026-11-05T09:00:00.000Z")] }, NOW), []);
  const fresh = session("waiting_permission", "2026-11-05T09:59:59.000Z");
  assert.equal(notifier.diff({ sessions: [fresh] }, NOW).length, 1);
  assert.equal(notifier.diff({ sessions: [fresh] }, NOW).length, 0);
  assert.equal(notifier.diff({ sessions: [session("waiting_permission", "2026-11-05T10:00:00.000Z")] }, NOW).length, 1);
});

test("project name handles Windows paths and trailing separators", () => {
  assert.equal(projectName({ recentEvents: [{ cwd: "C:\\code\\demo\\" } as never] }), "demo");
  assert.equal(projectName({ recentEvents: [] }), undefined);
});
