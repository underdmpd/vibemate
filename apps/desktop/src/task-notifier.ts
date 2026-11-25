import type { AggregatedSession, AggregatedSnapshot } from "./environment-types.js";

export type NoticeKind =
  | "completed"
  | "failed"
  | "waiting_permission"
  | "api_failed"
  | "api_timeout"
  | "process_exited"
  | "offline";

export interface TaskNotice {
  /** Session identity; matches the renderer's `${environmentId}/${agent}/${sessionId}`. */
  id: string;
  kind: NoticeKind;
  environmentName: string;
  project: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  agent: AggregatedSession["agent"];
  at: string;
}

const STATE_NOTICE_KINDS = new Set<string>(["completed", "failed", "waiting_permission"]);
const PROBLEM_NOTICE_KINDS = new Set<string>(["api_failed", "api_timeout", "process_exited"]);
/** A session seen for the first time only notifies if its last event is this recent (avoids replaying history on connect). */
const FRESH_WINDOW_MS = 15_000;
/** Must match preview.js OFFLINE_GRACE: a device must stay disconnected for 90s before notifying. */
export const OFFLINE_GRACE_MS = 90_000;

export function sessionIdentity(session: Pick<AggregatedSession, "environmentId" | "agent" | "sessionId">): string {
  return `${session.environmentId}/${session.agent}/${session.sessionId}`;
}

/** Last path segment of the most recent cwd the session reported, for Windows or POSIX paths. */
export function projectName(session: Pick<AggregatedSession, "recentEvents">): string | undefined {
  for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
    const cwd = session.recentEvents[index]?.cwd;
    if (!cwd) continue;
    const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (name) return name;
  }
  return undefined;
}

/**
 * Turns successive aggregated snapshots into "this task needs a look" notices.
 * Fires when a session completes, fails, waits for permission, hits one of the three upstream
 * problems (api_failed / api_timeout / process_exited), or is running on a device that has stayed
 * disconnected for at least 90 seconds.
 */
export class TaskNotifier {
  private readonly seen = new Map<string, string>();
  private readonly offlineSince = new Map<string, number>();

  diff(
    snapshot: Pick<AggregatedSnapshot, "sessions"> & Partial<Pick<AggregatedSnapshot, "environments">>,
    now = Date.now(),
  ): TaskNotice[] {
    const notices: TaskNotice[] = [];
    const present = new Set<string>();
    const lost = new Set<string>();
    const seenEnvs = new Set<string>();

    for (const env of snapshot.environments ?? []) {
      seenEnvs.add(env.environmentId);
      if (env.status === "connected") {
        this.offlineSince.delete(env.environmentId);
        continue;
      }
      if (env.status === "stopped") {
        this.offlineSince.delete(env.environmentId);
        continue;
      }
      const since = env.disconnectedAt ? Date.parse(env.disconnectedAt) : undefined;
      if (since !== undefined && Number.isFinite(since)) {
        this.offlineSince.set(env.environmentId, since);
      } else if (!this.offlineSince.has(env.environmentId)) {
        this.offlineSince.set(env.environmentId, now);
      }
      const startedAt = this.offlineSince.get(env.environmentId)!;
      if (now - startedAt >= OFFLINE_GRACE_MS) {
        lost.add(env.environmentId);
      }
    }
    for (const envId of this.offlineSince.keys()) {
      if (!seenEnvs.has(envId)) this.offlineSince.delete(envId);
    }

    for (const session of snapshot.sessions) {
      const id = sessionIdentity(session);
      present.add(id);

      const running = session.state === "working" || session.state === "thinking";
      let kind: NoticeKind | undefined;
      if (running && lost.has(session.environmentId)) {
        kind = "offline";
      } else if (session.problem && PROBLEM_NOTICE_KINDS.has(session.problem)) {
        kind = session.problem;
      } else if (STATE_NOTICE_KINDS.has(session.state)) {
        kind = session.state as NoticeKind;
      }

      const signature = kind === "offline"
        ? `offline|${this.offlineSince.get(session.environmentId) ?? ""}`
        : `${kind ?? session.state}|${session.updatedAt}`;
      const previous = this.seen.get(id);
      this.seen.set(id, signature);

      if (previous === signature || !kind) continue;
      if (kind !== "offline" && previous === undefined && now - Date.parse(session.updatedAt) > FRESH_WINDOW_MS) {
        continue;
      }

      notices.push({
        id,
        kind,
        environmentName: session.environmentName,
        project: session.project ?? projectName(session),
        ...(session.title ? { title: session.title } : {}),
        ...(session.summary ? { summary: session.summary } : {}),
        agent: session.agent,
        at: kind === "offline" ? new Date(now).toISOString() : session.updatedAt,
      });
    }
    for (const id of this.seen.keys()) {
      if (!present.has(id)) this.seen.delete(id);
    }
    return notices;
  }
}

const AGENT_NAMES: Record<string, string> = { codex: "Codex", copilot: "Copilot" };
const KIND_TEXT: Record<NoticeKind, string> = {
  completed: "完成了",
  failed: "失败了",
  waiting_permission: "等你确认",
  api_failed: "模型请求失败",
  api_timeout: "模型请求超时",
  process_exited: "进程没了",
  offline: "设备掉线",
};

export function describeNotice(notice: TaskNotice): { title: string; body: string } {
  const agent = AGENT_NAMES[notice.agent] ?? notice.agent;
  const label = notice.title ?? notice.project ?? agent;
  const prefix = `${notice.environmentName} · ${agent}`;
  return {
    title: `${label} ${KIND_TEXT[notice.kind]}`,
    body: notice.summary ? `${prefix} — ${notice.summary}` : prefix,
  };
}
