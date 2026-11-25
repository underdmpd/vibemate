$ProjectName = $env:VIBEMATE_FOCUS_PROJECT
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodeWindow {
    public delegate bool Callback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
function Set-TaskWindowForeground([IntPtr]$handle) {
    if (![CodeWindow]::IsIconic($handle) -and [CodeWindow]::GetForegroundWindow() -eq $handle) { return 'focused' }
    if ([CodeWindow]::IsIconic($handle)) { [void][CodeWindow]::ShowWindowAsync($handle, 9) }
    [void][CodeWindow]::SetForegroundWindow($handle)
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ([CodeWindow]::GetForegroundWindow() -eq $handle -and ![CodeWindow]::IsIconic($handle)) { return 'focused' }
        Start-Sleep -Milliseconds 20
    } while ($elapsed.ElapsedMilliseconds -lt 800)
    if ([CodeWindow]::GetForegroundWindow() -eq $handle -and ![CodeWindow]::IsIconic($handle)) { 'focused' } else { 'blocked' }
}
function Select-TerminalTab([IntPtr]$handle, [int]$index) {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
    $condition = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
    $tabs = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($index -ge $tabs.Count) { return }
    $selection = $tabs[$index].GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    if (!$selection.Current.IsSelected) { $selection.Select() }
}
if ($env:VIBEMATE_TERMINAL_TARGET) {
    if ($env:VIBEMATE_TERMINAL_TARGET -notmatch '^([1-9]\d{0,9}):([1-9]\d{0,9}):([1-9]\d{0,18})(?::(0|[1-9]\d{0,3}))?$') { 'unmatched'; return }
    $handle = [IntPtr]([long]$Matches[1])
    $expectedOwner = [long]$Matches[2]
    $started = $Matches[3]
    $tab = $Matches[4]
    [uint32]$owner = 0
    [void][CodeWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
    if ($owner -ne $expectedOwner -or ![CodeWindow]::IsWindowVisible($handle)) { 'unmatched'; return }
    $class = [Text.StringBuilder]::new(256)
    [void][CodeWindow]::GetClassName($handle, $class, $class.Capacity)
    if ($class.ToString() -ne 'CASCADIA_HOSTING_WINDOW_CLASS') { 'unmatched'; return }
    $terminal = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if (!$terminal -or $terminal.ProcessName -ne 'WindowsTerminal' -or [string]$terminal.StartTime.ToFileTimeUtc() -ne $started) { 'unmatched'; return }
    $result = Set-TaskWindowForeground $handle
    if ($result -eq 'focused' -and $null -ne $tab) {
        try { Select-TerminalTab $handle ([int]$tab) } catch {
            # Keep the terminal window focused if the tab is no longer accessible.
        }
    }
    $result
    return
}
$codeProcesses = @(Get-Process -Name 'Code','Code - Insiders' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$windows = [Collections.Generic.List[object]]::new()
[void][CodeWindow]::EnumWindows({
    param($handle, $unused)
    [uint32]$owner = 0
    [void][CodeWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
    if ($owner -in $codeProcesses -and [CodeWindow]::IsWindowVisible($handle)) {
        $text = [Text.StringBuilder]::new(2048)
        [void][CodeWindow]::GetClassName($handle, $text, $text.Capacity)
        if ($text.ToString() -eq 'Chrome_WidgetWin_1') {
            [void][CodeWindow]::GetWindowText($handle, $text, $text.Capacity)
            if ($text.Length) { $windows.Add([pscustomobject]@{ Handle = $handle; Title = $text.ToString() }) }
        }
    }
    return $true
}, [IntPtr]::Zero)
if (!$windows.Count) { 'none'; return }
$target = $windows[0]
if ($windows.Count -gt 1) {
    $matchesByProject = @($windows | Where-Object {
        # The default title ends in "<workspace> - Visual Studio Code".
        $separator = ' (?:-|\u2013|\u2014) '
        $ProjectName -and $_.Title -match ('(?:^|' + $separator + ')' + [regex]::Escape($ProjectName) + $separator + 'Visual Studio Code(?: - Insiders)?$')
    })
    if ($matchesByProject.Count -ne 1) { 'unmatched'; return }
    $target = $matchesByProject[0]
}
Set-TaskWindowForeground $target.Handle
