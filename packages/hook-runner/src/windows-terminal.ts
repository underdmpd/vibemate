import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Hooks may be launched with redirected handles or a detached wrapper. Walk only the
// hook's own ancestry and accept a console owned by a Windows Terminal window.
const readWindow = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TerminalConsole {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
}
"@
$candidate = [uint32]$env:VIBEMATE_HOOK_PROCESS
for ($depth = 0; $candidate -gt 0 -and $depth -lt 10; $depth++) {
  [void][TerminalConsole]::FreeConsole()
  if ([TerminalConsole]::AttachConsole($candidate)) {
    $window = [TerminalConsole]::GetAncestor([TerminalConsole]::GetConsoleWindow(), 3)
    [uint32]$owner = 0
    [void][TerminalConsole]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner) {
      $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
      if ($process.ProcessName -eq 'WindowsTerminal') {
        '{0}:{1}:{2}' -f $window.ToInt64(), $owner, $process.StartTime.ToFileTimeUtc()
        return
      }
    }
  }
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate"
  if (!$current -or !$current.ParentProcessId) { break }
  $parent = Get-Process -Id $current.ParentProcessId -ErrorAction SilentlyContinue
  if (!$parent -or $parent.StartTime -gt $current.CreationDate -or $parent.ProcessName -in 'Code','Code - Insiders','explorer','WindowsTerminal') { break }
  $candidate = $current.ParentProcessId
}`;

export async function windowsTerminalTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probe = async () => (await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", readWindow,
  ], { windowsHide: true, timeout: 3000, env: { ...env, VIBEMATE_HOOK_PROCESS: String(process.pid) } })).stdout.trim(),
): Promise<string | undefined> {
  if (platform !== "win32" || !env.WT_SESSION || env.TERM_PROGRAM?.toLowerCase() === "vscode" || env.VSCODE_INJECTION) return undefined;
  const target = await probe().catch(() => "");
  return /^[1-9]\d{0,9}:[1-9]\d{0,9}:[1-9]\d{0,18}$/.test(target) ? target : "unknown";
}
