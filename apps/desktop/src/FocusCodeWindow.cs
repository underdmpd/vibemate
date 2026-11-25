using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
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
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static bool IsCodeProcess(uint pid)
    {
        var handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) return false;
        try {
            var path = new StringBuilder(32768);
            int size = path.Capacity;
            if (!QueryFullProcessImageName(handle, 0, path, ref size)) return false;
            var name = Path.GetFileName(path.ToString());
            return String.Equals(name, "Code.exe", StringComparison.OrdinalIgnoreCase)
                || String.Equals(name, "Code - Insiders.exe", StringComparison.OrdinalIgnoreCase);
        } finally { CloseHandle(handle); }
    }

    private static string Focus(string project, bool allowForegroundRetry)
    {
        var owners = new Dictionary<uint, bool>();
        var windows = new List<KeyValuePair<IntPtr, string>>();
        var text = new StringBuilder(2048);
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint pid;
            if (!IsWindowVisible(window) || GetClassName(window, text, text.Capacity) == 0
                || text.ToString() != "Chrome_WidgetWin_1") return true;
            GetWindowThreadProcessId(window, out pid);
            bool isCode;
            if (!owners.TryGetValue(pid, out isCode)) owners[pid] = isCode = IsCodeProcess(pid);
            if (isCode && GetWindowText(window, text, text.Capacity) > 0)
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
        if (!SetForegroundWindow(target) && allowForegroundRetry && GetForegroundWindow() != target) return "retry";
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
        if (args.Length == 2 && args[0] == "--serve" && args[1] == "stdin") {
            string line;
            while ((line = Console.ReadLine()) != null) {
                string project = Encoding.UTF8.GetString(Convert.FromBase64String(line));
                Console.WriteLine(Focus(project, true));
                Console.Out.Flush();
            }
            return;
        }
        if (args.Length == 1) Console.WriteLine(Focus(args[0], false));
    }
}
