import { createHash, randomUUID } from "node:crypto";
import {
  extractFirstLine,
  extractLastSentence,
  MAX_CWD_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_SUMMARY_LENGTH,
  sanitizeText,
  type AgentId,
} from "@vibemate/protocol";

const BOUNDED_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

export class AdapterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterInputError";
  }
}

export interface AdapterRuntimeOptions {
  sourceProfile?: string;
  now?: () => Date;
  generateId?: () => string;
  permissionTimeoutMs?: number;
}

export interface ToolMetadataInput {
  name: string;
  input?: unknown;
}

export type AdapterPermissionOutcome =
  | {
      requestId: string;
      decision: "allow" | "deny";
      decidedAt: string;
    }
  | {
      requestId: string;
      decision: "no_decision";
      reason: string;
      decidedAt: string;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new AdapterInputError(`${label} must be an object`);
  }
  return record;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

export function decodeJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function readOptionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function requireString(label: string, ...values: unknown[]): string {
  const value = readOptionalString(...values);
  if (!value) {
    throw new AdapterInputError(`${label} is required`);
  }
  return value;
}

export function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function sanitizePromptTitle(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const firstLine = extractFirstLine(candidate);
    if (!firstLine) continue;
    const cleaned = sanitizeText(firstLine, { maxLength: MAX_TITLE_LENGTH, redactSecrets: true });
    if (cleaned) return cleaned;
  }
  return undefined;
}

export function sanitizeReplySummary(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const sentence = extractLastSentence(candidate);
    if (!sentence) continue;
    const cleaned = sanitizeText(sentence, { maxLength: MAX_SUMMARY_LENGTH, redactSecrets: true });
    if (cleaned) return cleaned;
  }
  return undefined;
}

export function sanitizeErrorSummary(value: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof value === "string") {
    raw = value;
  } else {
    const record = asRecord(value);
    if (record && typeof record.message === "string") {
      raw = record.message;
    }
  }
  if (!raw) return undefined;
  let text = raw.trim();
  // Unwrap JSON error envelopes (e.g. Codex PostModelRequest: '{"error":{"message":"..."},"request_id":"..."}')
  // and JSON-quoted strings (e.g. Copilot native error message wrapped in quotes).
  for (let depth = 0; depth < 2; depth += 1) {
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("\"") && text.endsWith("\""))) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "string") {
          text = parsed.trim();
          continue;
        }
        const parsedRecord = asRecord(parsed);
        const nested = asRecord(parsedRecord?.error);
        const message = typeof nested?.message === "string"
          ? nested.message
          : typeof parsedRecord?.message === "string"
            ? parsedRecord.message
            : undefined;
        if (message) {
          text = message.trim();
          continue;
        }
      } catch {
        break;
      }
    }
    break;
  }
  const firstLine = extractFirstLine(text);
  if (!firstLine) return undefined;
  const cleaned = sanitizeText(firstLine, { maxLength: MAX_SUMMARY_LENGTH, redactSecrets: true });
  return cleaned || undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = optionalRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function fingerprintInput(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value));
  } catch {
    return undefined;
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function buildToolMetadata(input: ToolMetadataInput) {
  const name = sanitizeText(input.name, { maxLength: MAX_TOOL_NAME_LENGTH });
  if (!name || /^unknown$/i.test(name)) {
    throw new AdapterInputError("tool name is invalid");
  }

  const rawInput = optionalRecord(input.input);
  const rawDescription = rawInput?.description;
  const summary = typeof rawDescription === "string"
    ? sanitizeText(rawDescription, { maxLength: MAX_TOOL_SUMMARY_LENGTH })
    : `Request to use ${name}`;
  const inputFingerprint = fingerprintInput(input.input);

  return {
    name,
    ...(summary ? { summary } : {}),
    ...(inputFingerprint ? { inputFingerprint } : {}),
  };
}

export class AdapterRuntime {
  readonly sourceProfile: string;
  readonly permissionTimeoutMs: number;
  private readonly nowProvider: () => Date;
  private readonly idProvider: () => string;
  private readonly activeTurns = new Map<string, string>();

  constructor(options: AdapterRuntimeOptions = {}) {
    this.sourceProfile = options.sourceProfile ?? "local";
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 9 * 60 * 1_000;
    this.nowProvider = options.now ?? (() => new Date());
    this.idProvider = options.generateId ?? randomUUID;
  }

  now(): Date {
    return this.nowProvider();
  }

  occurredAt(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
    return this.now().toISOString();
  }

  eventId(...candidates: unknown[]): string {
    return this.boundedId(candidates) ?? this.idProvider();
  }

  requestId(...candidates: unknown[]): string {
    return this.boundedId(candidates) ?? this.idProvider();
  }

  startTurn(agent: AgentId, sessionId: string, preferred?: unknown): string {
    const turnId = this.boundedId([preferred]) ?? `turn-${this.idProvider()}`;
    this.activeTurns.set(this.turnKey(agent, sessionId), turnId);
    return turnId;
  }

  currentTurn(agent: AgentId, sessionId: string): string | undefined {
    return this.activeTurns.get(this.turnKey(agent, sessionId));
  }

  ensureTurn(agent: AgentId, sessionId: string, preferred?: unknown): string {
    const explicit = this.boundedId([preferred]);
    if (explicit) {
      this.activeTurns.set(this.turnKey(agent, sessionId), explicit);
      return explicit;
    }
    return this.currentTurn(agent, sessionId) ?? this.startTurn(agent, sessionId);
  }

  cwd(value: unknown): string | undefined {
    return typeof value === "string" && value.trim()
      ? sanitizeText(value, { maxLength: MAX_CWD_LENGTH, collapseWhitespace: false })
      : undefined;
  }

  expiresAt(): string {
    return new Date(this.now().getTime() + this.permissionTimeoutMs).toISOString();
  }

  private boundedId(values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && BOUNDED_ID.test(value.trim())) {
        return value.trim();
      }
    }
    return undefined;
  }

  private turnKey(agent: AgentId, sessionId: string): string {
    return `${agent}\u0000${sessionId}`;
  }
}
