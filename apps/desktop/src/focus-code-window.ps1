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
if ([CodeWindow]::IsIconic($target.Handle)) { [void][CodeWindow]::ShowWindowAsync($target.Handle, 9) }
[void][CodeWindow]::SetForegroundWindow($target.Handle)
if ([CodeWindow]::GetForegroundWindow() -eq $target.Handle) { 'focused' } else { 'blocked' }
