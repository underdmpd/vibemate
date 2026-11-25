import {
  createSessionKey,
  type AgentEvent,
  type SessionIdentity,
  type SessionProblem,
  type UnifiedState,
} from "@vibemate/protocol";

export interface SessionSnapshot extends SessionIdentity {
  key: string;
  state: UnifiedState;
  updatedAt: string;
  startedAt?: string;
  title?: string;
  summary?: string;
  problem?: SessionProblem;
  terminalTarget?: string;
  recentEvents: AgentEvent[];
}

export type ApplyEventOutcome =
  | { result: "applied"; session: SessionSnapshot }
  | { result: "duplicate_event"; session: SessionSnapshot }
  | { result: "duplicate_completion"; session: SessionSnapshot }
  | { result: "stale"; session: SessionSnapshot };

interface SessionRecord extends Omit<SessionSnapshot, "startedAt" | "title" | "summary" | "problem"> {
  startedAt?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  problem?: SessionProblem | undefined;
  stateOccurredAtMs: number;
  stateEventId: string;
  lastEventName: string;
  sourcePid?: number | undefined;
  awaitingModelSinceMs?: number | undefined;
  consecutiveApiFailures: number;
  lastApiErrorSummary?: string | undefined;
  completedTurns: Set<string>;
  completedTurnOrder: string[];
}

export interface SessionStoreOptions {
  maxRecentEvents?: number;
  maxSeenEventIds?: number;
  maxCompletedTurnsPerSession?: number;
  /** Number of consecutive recoverable model-call failures before flagging api_failed. Default: 3. */
  recoverableApiFailureThreshold?: number;
}

const MODEL_WAIT_EVENTS = new Set([
  "UserPromptSubmit",
  "PreModelRequest",
  "userPromptSubmitted",
  "postToolUse",
]);

const TURN_START_EVENTS = new Set([
  "UserPromptSubmit",
  "userPromptSubmitted",
]);

function isRunningState(state: UnifiedState): boolean {
  return state === "thinking" || state === "working";
}

function compareEvents(left: AgentEvent, right: AgentEvent): number {
  const timeDifference = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return timeDifference || left.eventId.localeCompare(right.eventId);
}

function compareEventToState(event: AgentEvent, record: SessionRecord): number {
  const timeDifference = Date.parse(event.occurredAt) - record.stateOccurredAtMs;
  return timeDifference || event.eventId.localeCompare(record.stateEventId);
}

function cloneSnapshot(record: SessionRecord): SessionSnapshot {
  return {
    key: record.key,
    sourceProfile: record.sourceProfile,
    agent: record.agent,
    sessionId: record.sessionId,
    state: record.state,
    updatedAt: record.updatedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.title ? { title: record.title } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.problem ? { problem: record.problem } : {}),
    ...(record.terminalTarget ? { terminalTarget: record.terminalTarget } : {}),
    recentEvents: structuredClone(record.recentEvents),
  };
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxRecentEvents: number;
  private readonly maxSeenEventIds: number;
  private readonly maxCompletedTurnsPerSession: number;
  private readonly recoverableApiFailureThreshold: number;

  constructor(options: SessionStoreOptions = {}) {
    this.maxRecentEvents = options.maxRecentEvents ?? 50;
    this.maxSeenEventIds = options.maxSeenEventIds ?? 10_000;
    this.maxCompletedTurnsPerSession = options.maxCompletedTurnsPerSession ?? 256;
    this.recoverableApiFailureThreshold = options.recoverableApiFailureThreshold ?? 3;
  }

  apply(event: AgentEvent, terminalTarget?: string): ApplyEventOutcome {
    const key = createSessionKey(event);
    let record = this.sessions.get(key);
    const dedupeKey = `${key}\u0000${event.eventId}`;
    if (this.seenEventIds.has(dedupeKey)) {
      if (!record) {
        throw new Error("event deduplication state is inconsistent");
      }
      return { result: "duplicate_event", session: cloneSnapshot(record) };
    }
    this.rememberEventId(dedupeKey);

    if (
      record
      && event.state === "completed"
      && event.turnId
      && record.completedTurns.has(event.turnId)
    ) {
      return { result: "duplicate_completion", session: cloneSnapshot(record) };
    }

    if (!record) {
      record = {
        key,
        sourceProfile: event.sourceProfile,
        agent: event.agent,
        sessionId: event.sessionId,
        state: event.state,
        updatedAt: event.occurredAt,
        stateOccurredAtMs: Date.parse(event.occurredAt),
        stateEventId: event.eventId,
        lastEventName: event.event,
        ...(terminalTarget ? { terminalTarget } : {}),
        consecutiveApiFailures: 0,
        recentEvents: [structuredClone(event)],
        completedTurns: new Set(),
        completedTurnOrder: [],
      };
      this.applyMetadata(record, event);
      this.sessions.set(key, record);
      if (event.state === "completed" && event.turnId) {
        this.rememberCompletedTurn(record, event.turnId);
      }
      this.notify();
      return { result: "applied", session: cloneSnapshot(record) };
    }

    this.rememberRecentEvent(record, event);
    if (compareEventToState(event, record) <= 0) {
      this.notify();
      return { result: "stale", session: cloneSnapshot(record) };
    }

    // Preserve api_failed when a session ends right after an api_failed or recoverable model failures
    // (e.g. Codex PostModelRequest(failed) -> SessionEnd, or Copilot errorOccurred -> sessionEnd(error)).
    const preserveErrorEnd = event.state === "ended"
      && (record.problem === "api_failed"
        || (event.problem === "api_failed" && record.consecutiveApiFailures > 0));

    if (terminalTarget) record.terminalTarget = terminalTarget;
    else delete record.terminalTarget;
    record.updatedAt = event.occurredAt;
    record.stateOccurredAtMs = Date.parse(event.occurredAt);
    record.stateEventId = event.eventId;
    record.lastEventName = event.event;

    if (preserveErrorEnd) {
      record.state = "failed";
      record.problem = "api_failed";
      record.summary = event.summary ?? record.summary ?? record.lastApiErrorSummary;
      record.awaitingModelSinceMs = undefined;
      record.consecutiveApiFailures = 0;
    } else {
      this.applyStateAndMetadata(record, event);
    }

    if (event.state === "completed" && event.turnId) {
      this.rememberCompletedTurn(record, event.turnId);
    }
    this.notify();

    return { result: "applied", session: cloneSnapshot(record) };
  }

  /**
   * Checks running sessions for model-request timeouts and exited agent processes.
   * Only sessions explicitly waiting on a model response are timed for api_timeout;
   * tool execution phases are never timed.
   */
  evaluateHealth(options: {
    nowMs?: number;
    apiTimeoutMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  }): number {
    const nowMs = options.nowMs ?? Date.now();
    const apiTimeoutMs = options.apiTimeoutMs;
    const isProcessAlive = options.isProcessAlive;
    let changed = 0;

    for (const record of this.sessions.values()) {
      if (!isRunningState(record.state) || record.problem) {
        continue;
      }

      if (isProcessAlive && record.sourcePid !== undefined) {
        let alive = true;
        try {
          alive = isProcessAlive(record.sourcePid);
        } catch {
          alive = true;
        }
        if (!alive) {
          record.problem = "process_exited";
          record.awaitingModelSinceMs = undefined;
          record.updatedAt = new Date(nowMs).toISOString();
          record.stateOccurredAtMs = Math.max(record.stateOccurredAtMs, nowMs);
          changed += 1;
          continue;
        }
      }

      if (
        apiTimeoutMs !== undefined
        && apiTimeoutMs > 0
        && record.awaitingModelSinceMs !== undefined
        && nowMs - record.awaitingModelSinceMs >= apiTimeoutMs
      ) {
        record.problem = "api_timeout";
        record.awaitingModelSinceMs = undefined;
        record.updatedAt = new Date(nowMs).toISOString();
        record.stateOccurredAtMs = Math.max(record.stateOccurredAtMs, nowMs);
        changed += 1;
      }
    }

    if (changed > 0) {
      this.notify();
    }
    return changed;
  }

  get(identity: SessionIdentity): SessionSnapshot | undefined {
    const record = this.sessions.get(createSessionKey(identity));
    return record ? cloneSnapshot(record) : undefined;
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .map(cloneSnapshot)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private applyMetadata(record: SessionRecord, event: AgentEvent): void {
    this.applyStateAndMetadata(record, event);
  }

  private applyStateAndMetadata(record: SessionRecord, event: AgentEvent): void {
    if (event.process?.sourcePid) {
      record.sourcePid = event.process.sourcePid;
    }
    if (event.title) {
      record.title = event.title;
    }

    // Debounce recoverable model-call failures (retries) so transient blips don't alarm the user.
    if (event.problem === "api_failed" && event.recoverable === true) {
      record.consecutiveApiFailures += 1;
      if (event.summary) {
        record.lastApiErrorSummary = event.summary;
      }
      if (record.consecutiveApiFailures < this.recoverableApiFailureThreshold) {
        record.state = "thinking";
        record.problem = undefined;
        record.awaitingModelSinceMs = Date.parse(event.occurredAt);
        return;
      }
      record.state = "failed";
      record.problem = "api_failed";
      record.summary = event.summary ?? record.lastApiErrorSummary;
      record.awaitingModelSinceMs = undefined;
      return;
    }

    record.state = event.state;

    if (TURN_START_EVENTS.has(event.event)) {
      record.startedAt = event.occurredAt;
      record.summary = undefined;
      record.problem = undefined;
      record.consecutiveApiFailures = 0;
      record.lastApiErrorSummary = undefined;
    } else if (event.event === "PreModelRequest") {
      // Starting a new model request clears a previous transient problem only when retrying/continuing,
      // while keeping startedAt for the active turn.
      if (!record.startedAt) {
        record.startedAt = event.occurredAt;
      }
      if (record.problem === "api_timeout") {
        record.problem = undefined;
      }
    } else if (isRunningState(event.state)) {
      if (!record.startedAt) {
        record.startedAt = event.occurredAt;
      }
      if (event.problem) {
        record.problem = event.problem;
      } else {
        record.problem = undefined;
        record.consecutiveApiFailures = 0;
        record.lastApiErrorSummary = undefined;
      }
      if (event.summary) {
        record.summary = event.summary;
      }
    } else {
      // Terminal or waiting state (completed / failed / waiting_permission / idle / ended)
      record.consecutiveApiFailures = 0;
      record.problem = event.problem;
      if (event.summary !== undefined) {
        record.summary = event.summary;
      } else if (event.state === "completed" || event.state === "idle" || event.state === "ended") {
        record.summary = undefined;
      }
      if (event.state === "completed" || event.state === "failed" || event.state === "ended" || event.state === "idle") {
        record.lastApiErrorSummary = undefined;
      }
    }

    if (isRunningState(record.state) && !record.problem && MODEL_WAIT_EVENTS.has(event.event)) {
      record.awaitingModelSinceMs = Date.parse(event.occurredAt);
    } else {
      record.awaitingModelSinceMs = undefined;
    }
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    while (this.seenEventOrder.length > this.maxSeenEventIds) {
      const removed = this.seenEventOrder.shift();
      if (removed) {
        this.seenEventIds.delete(removed);
      }
    }
  }

  private rememberRecentEvent(record: SessionRecord, event: AgentEvent): void {
    record.recentEvents.push(structuredClone(event));
    record.recentEvents.sort(compareEvents);
    if (record.recentEvents.length > this.maxRecentEvents) {
      record.recentEvents.splice(0, record.recentEvents.length - this.maxRecentEvents);
    }
  }

  private rememberCompletedTurn(record: SessionRecord, turnId: string): void {
    record.completedTurns.add(turnId);
    record.completedTurnOrder.push(turnId);
    while (record.completedTurnOrder.length > this.maxCompletedTurnsPerSession) {
      const removed = record.completedTurnOrder.shift();
      if (removed) {
        record.completedTurns.delete(removed);
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
