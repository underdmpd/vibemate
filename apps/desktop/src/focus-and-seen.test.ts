import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { AggregatedSession, EnvironmentView } from "./environment-types.js";
import { buildFocusCommand, findLocalGitRoot, focusSessionWindow } from "./focus-session.js";
import { SeenSessionStore } from "./seen-store.js";

test("buildFocusCommand builds Tier-1 VS Code commands for windows, wsl, and ssh", () => {
  assert.deepEqual(
    buildFocusCommand({ kind: "windows" }, "C:\\work\\app", "win32"),
    { command: "code.cmd", args: ["C:\\work\\app"] },
  );
  assert.deepEqual(
    buildFocusCommand({ kind: "wsl", distribution: "Ubuntu" }, "/home/user/app", "win32"),
    { command: "code.cmd", args: ["--remote", "wsl+Ubuntu", "/home/user/app"] },
  );
  assert.deepEqual(
    buildFocusCommand({ kind: "ssh", sshHost: "pi" }, "/home/pi/app", "linux"),
    { command: "code", args: ["--remote", "ssh-remote+pi", "/home/pi/app"] },
  );
});

test("focusSessionWindow resolves local git root for subdirectories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "vibemate-focus-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sub = join(root, "packages", "sub");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(sub, { recursive: true });

  assert.equal(await findLocalGitRoot(sub), root);

  const env: EnvironmentView = {
    environmentId: "w1",
    deviceId: "d1",
    name: "Windows 本机",
    kind: "windows",
    enabled: true,
    status: "connected",
    manuallyStarted: false,
  };
  const session: AggregatedSession = {
    key: "k",
    sourceProfile: "w1",
    agent: "codex",
    sessionId: "s1",
    state: "completed",
    updatedAt: "2026-11-25T00:00:00.000Z",
    recentEvents: [{ cwd: sub } as never],
    deviceId: "d1",
    environmentId: "w1",
    environmentName: "Windows 本机",
  };
  const projects: string[] = [];
  const options = {
    platform: "win32" as const,
    activateExisting: async (project: string) => { projects.push(project); },
    runCommand: async () => { throw new Error("local jump must never open a folder"); },
  };
  await focusSessionWindow(env, session, options);
  await focusSessionWindow(env, { ...session, recentEvents: [] }, options);
  assert.deepEqual(projects, [basename(root), ""]);
});

test("SeenSessionStore persists marks across reload", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "vibemate-seen-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "seen-sessions.json");

  const first = new SeenSessionStore(file);
  await first.load();
  await first.markSeen("e1/codex/s1", "2026-11-25T00:00:00.000Z/");
  assert.deepEqual(first.getAll(), { "e1/codex/s1": "2026-11-25T00:00:00.000Z/" });

  const second = new SeenSessionStore(file);
  await second.load();
  assert.deepEqual(second.getAll(), { "e1/codex/s1": "2026-11-25T00:00:00.000Z/" });
});
