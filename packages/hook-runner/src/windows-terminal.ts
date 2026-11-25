import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Hooks may be launched with redirected handles or a detached wrapper. Walk only the
// hook's own ancestry and accept a console owned by a Windows Terminal window.
const readWindow = String.raw`
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
function Get-SelectedTabIndex([IntPtr]$window) {
  if ([TerminalConsole]::GetForegroundWindow() -ne $window) { return }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [Windows.Automation.AutomationElement]::FromHandle($window)
  $condition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
  for ($index = 0; $index -lt $tabs.Count; $index++) {
    $selection = $tabs[$index].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection.Current.IsSelected -and [TerminalConsole]::GetForegroundWindow() -eq $window) { return $index }
  }
}
$candidate = [uint32]$env:VIBEMATE_HOOK_PROCESS
if ($env:VIBEMATE_COPILOT_SESSION_DIR) {
  $locks = @(Get-ChildItem -LiteralPath $env:VIBEMATE_COPILOT_SESSION_DIR -Filter 'inuse.*.lock' -File -ErrorAction SilentlyContinue)
  $clients = @(foreach ($lock in $locks) {
    if ($lock.Name -notmatch '^inuse\.([1-9]\d{0,8})\.lock$') { continue }
    $client = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
    if ($client -and $client.ProcessName -eq 'copilot' -and $client.StartTime -le $lock.LastWriteTime) { $client }
  })
  if ($clients.Count -eq 1) { $candidate = [uint32]$clients[0].Id }
}
for ($depth = 0; $candidate -gt 0 -and $depth -lt 10; $depth++) {
  [void][TerminalConsole]::FreeConsole()
  if ([TerminalConsole]::AttachConsole($candidate)) {
    $window = [TerminalConsole]::GetAncestor([TerminalConsole]::GetConsoleWindow(), 3)
    [uint32]$owner = 0
    [void][TerminalConsole]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner) {
      $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
      if ($process.ProcessName -eq 'WindowsTerminal') {
        $target = '{0}:{1}:{2}' -f $window.ToInt64(), $owner, $process.StartTime.ToFileTimeUtc()
        if ($env:VIBEMATE_CAPTURE_TAB -eq '1') {
          try {
            $index = Get-SelectedTabIndex $window
            if ($null -ne $index) { $target += ":$index" }
          } catch {
            # Tab controls may be hidden or inaccessible. Keep the window target.
          }
        }
        $target
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
  ], { windowsHide: true, timeout: 3000, env: {
    ...env, VIBEMATE_HOOK_PROCESS: String(process.pid),
    VIBEMATE_CAPTURE_TAB: captureTab ? "1" : "",
    VIBEMATE_COPILOT_SESSION_DIR: copilotSession && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(copilotSession)
      ? join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", copilotSession) : "",
  } })).stdout.trim(),
  copilotSession?: string,
  captureTab = false,
): Promise<string | undefined> {
  if (platform !== "win32" || env.TERM_PROGRAM?.toLowerCase() === "vscode" || env.VSCODE_INJECTION) return undefined;
  // A CLI can filter WT_SESSION from the hook's environment while its console
  // still belongs to Windows Terminal. Prefer the verified window in that case.
  const target = await probe().catch(() => "");
  if (/^[1-9]\d{0,9}:[1-9]\d{0,9}:[1-9]\d{0,18}(?::(?:0|[1-9]\d{0,3}))?$/.test(target)) return target;
  return env.WT_SESSION ? "unknown" : undefined;
}
