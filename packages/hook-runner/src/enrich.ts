import { open, readFile, stat } from "node:fs/promises";

const MAX_TRANSCRIPT_TAIL_BYTES = 32 * 1024;
const SHELL_NAMES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ash",
  "ksh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

function normalizeProcName(name: string): string {
  return name.trim().toLowerCase();
}

async function readLinuxProcessParent(pid: number): Promise<{ comm: string; ppid: number } | undefined> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf8");
    // Format: pid (comm) state ppid ...  Note comm can contain spaces or parentheses.
    const openParen = content.indexOf("(");
    const closeParen = content.lastIndexOf(")");
    if (openParen < 0 || closeParen <= openParen) return undefined;
    const comm = content.slice(openParen + 1, closeParen);
    const rest = content.slice(closeParen + 2).trim().split(/\s+/);
    // rest[0] is state, rest[1] is ppid
    const ppid = Number(rest[1]);
    if (!Number.isInteger(ppid) || ppid <= 0) return undefined;
    return { comm, ppid };
  } catch {
    return undefined;
  }
}

/**
 * Walks up the parent process chain to skip transient wrapper shells (e.g. bash -c, sh -c)
 * and return the long-lived Agent host process PID.
 * On non-Linux platforms where /proc is unavailable, returns undefined unless safely verifiable
 * (preventing false "process_exited" alarms from short-lived PowerShell/cmd shells).
 */
export async function resolveAgentSourcePid(
  startPid: number = process.ppid,
  options: {
    platform?: NodeJS.Platform;
    readParent?: (pid: number) => Promise<{ comm: string; ppid: number } | undefined>;
  } = {},
): Promise<number | undefined> {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(startPid) || startPid <= 1) return undefined;

  if (platform !== "linux") {
    return undefined;
  }

  const readParent = options.readParent ?? readLinuxProcessParent;
  let current = startPid;
  for (let depth = 0; depth < 6 && current > 1; depth += 1) {
    const info = await readParent(current);
    if (!info) return undefined;
    if (!SHELL_NAMES.has(normalizeProcName(info.comm))) {
      return current;
    }
    if (info.ppid === current || info.ppid <= 1) return undefined;
    current = info.ppid;
  }
  return undefined;
}

/**
 * Reads only the tail of a Copilot session events.jsonl transcript and extracts the last
 * non-empty assistant.message content, without loading or transmitting the full file.
 */
export async function readCopilotLastAssistantMessage(transcriptPath: string): Promise<string | undefined> {
  if (!transcriptPath || typeof transcriptPath !== "string") return undefined;
  let handle;
  try {
    const metadata = await stat(transcriptPath);
    if (!metadata.isFile() || metadata.size === 0) return undefined;
    const length = Math.min(metadata.size, MAX_TRANSCRIPT_TAIL_BYTES);
    const offset = metadata.size - length;
    handle = await open(transcriptPath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    // If we started mid-file, drop the potentially truncated first line.
    if (offset > 0 && lines.length > 0) lines.shift();

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        if (record.type !== "assistant.message") continue;
        const data = record.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        const content = (data as Record<string, unknown>).content;
        if (typeof content === "string" && content.trim()) {
          return content.trim();
        }
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
