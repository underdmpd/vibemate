using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class FocusCodeWindow
{
    private delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    private static string Focus(string project)
    {
        var owners = new HashSet<uint>();
        foreach (string name in new[] { "Code", "Code - Insiders" })
            foreach (var process in Process.GetProcessesByName(name))
                using (process) owners.Add((uint)process.Id);

        var windows = new List<KeyValuePair<IntPtr, string>>();
        var text = new StringBuilder(2048);
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (owners.Contains(pid) && IsWindowVisible(window)
                && GetClassName(window, text, text.Capacity) > 0 && text.ToString() == "Chrome_WidgetWin_1"
                && GetWindowText(window, text, text.Capacity) > 0)
                windows.Add(new KeyValuePair<IntPtr, string>(window, text.ToString()));
            return true;
        }, IntPtr.Zero);
        if (windows.Count == 0) return "none";
        if (windows.Count > 1) {
            if (String.IsNullOrEmpty(project)) return "unmatched";
            const string separator = " [-\u2013\u2014] ";
            var suffix = new Regex("(?:^|" + separator + ")" + Regex.Escape(project) + separator
                + "Visual Studio Code(?: - Insiders)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            windows = windows.FindAll(window => suffix.IsMatch(window.Value));
            if (windows.Count != 1) return "unmatched";
        }
        var target = windows[0].Key;
        if (!IsIconic(target) && GetForegroundWindow() == target) return "focused";
        if (IsIconic(target)) ShowWindowAsync(target, 9);
        SetForegroundWindow(target);
        // Activation across UI threads can finish after SetForegroundWindow returns.
        var elapsed = Stopwatch.StartNew();
        do {
            if (GetForegroundWindow() == target && !IsIconic(target)) return "focused";
            Thread.Sleep(20);
        } while (elapsed.ElapsedMilliseconds < 800);
        return GetForegroundWindow() == target && !IsIconic(target) ? "focused" : "blocked";
    }

    public static void Main(string[] args)
    {
        if (args.Length == 1) Console.WriteLine(Focus(args[0]));
    }
}
