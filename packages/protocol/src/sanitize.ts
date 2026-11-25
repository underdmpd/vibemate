const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]{8,}["']?/gi,
];

export interface SanitizeTextOptions {
  maxLength: number;
  collapseWhitespace?: boolean;
  redactSecrets?: boolean;
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, key?: string) => (key ? `${key}=[REDACTED]` : "[REDACTED]"));
  }
  return result;
}

export function extractFirstLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function extractLastSentence(value: string): string {
  const paragraphs = value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = paragraphs[paragraphs.length - 1] ?? "";
  if (!candidate) return "";
  // Prefer the last complete sentence if the final paragraph has multiple sentences.
  const parts = candidate
    .split(/(?<=[。！？.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? candidate;
}

export function sanitizeText(value: string, options: SanitizeTextOptions): string {
  const withoutControls = value.replace(CONTROL_CHARACTERS, " ");
  const cleaned = options.redactSecrets ? redactSecrets(withoutControls) : withoutControls;
  const normalized = options.collapseWhitespace === false
    ? cleaned.trim()
    : cleaned.replace(/\s+/g, " ").trim();

  if (normalized.length <= options.maxLength) {
    return normalized;
  }

  if (options.maxLength <= 1) {
    return normalized.slice(0, options.maxLength);
  }

  return `${normalized.slice(0, options.maxLength - 1)}…`;
}
