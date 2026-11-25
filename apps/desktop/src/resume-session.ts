import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { AggregatedSession, EnvironmentView } from "./environment-types.js";
import { sessionCwd, WindowFocusError } from "./focus-session.js";

const run = promisify(execFile);

export function resumeTerminalArgs(agent: "codex" | "copilot", id: string, cwd: string): string[] {
  // Both CLIs also accept names or prefixes. Only request the exact recorded UUID.
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new WindowFocusError("这条记录缺少可恢复的会话 ID。");
  }
  // Pass the path as data, including quotes, Unicode and Windows Terminal's ';' separator.
  const encodedDir = Buffer.from(cwd, "utf8").toString("base64");
  const args = agent === "codex" ? `'resume' '${id}'` : `'--resume=${id}'`;
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $cli = Get-Command '${agent}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$cli) { throw '找不到 ${agent} 命令。请确认已安装 CLI 并加入 PATH。' }
  $directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDir}'))
  Set-Location -LiteralPath $directory
  & $cli.Source ${args}
  if ($LASTEXITCODE -ne 0) { throw '未能恢复这条对话。请查看上面的 CLI 提示，确认原账号下仍有这条历史记录。' }
} catch {
  Write-Host $_.Exception.Message
  [void](Read-Host '按回车关闭')
}`;
  return ["-w", "0", "new-tab", "powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")];
}

export async function resumeSession(environment: EnvironmentView, session: AggregatedSession): Promise<void> {
  if (process.platform !== "win32" || environment.kind !== "windows" || environment.status !== "connected"
      || session.state !== "ended" || (session.agent !== "codex" && session.agent !== "copilot")) {
    throw new WindowFocusError("只有已结束的本机 Codex 或 Copilot CLI 会话可以继续。");
  }
  const cwd = sessionCwd(session);
  if (!cwd || !win32.isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw new WindowFocusError("找不到这条对话原来的工作目录。");
  }
  const args = resumeTerminalArgs(session.agent, session.sessionId, cwd);
  try {
    await run("wt.exe", args, { timeout: 8000 });
  } catch {
    throw new WindowFocusError("无法启动 Windows Terminal，请确认已安装并启用了 wt.exe。");
  }
}
