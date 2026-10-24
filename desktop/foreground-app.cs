using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// One observation, one process handle, no subprocesses. Never read a window title,
// process image path/command line, process list, document, URL, or screen content.
internal static class ForegroundApp
{
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint DesktopReadObjects = 0x0001;
    private const uint WindowStationVisible = 0x0001;

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint K32GetModuleBaseNameW(IntPtr process, IntPtr module, StringBuilder name, uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetObjectName(IntPtr handle, int index, StringBuilder value, int bytes, out int needed);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", ExactSpelling = true)]
    private static extern bool GetObjectFlags(IntPtr handle, int index, out ObjectFlags value, int bytes, out int needed);
    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectFlags { public int Inherit; public int Reserved; public uint Flags; }

    private static bool InteractiveDefaultDesktop()
    {
        ObjectFlags flags; int needed;
        IntPtr station = GetProcessWindowStation(); // Borrowed handle, not ours to close.
        if (station == IntPtr.Zero || !GetObjectFlags(station, 1, out flags, Marshal.SizeOf(typeof(ObjectFlags)), out needed)
            || (flags.Flags & WindowStationVisible) == 0) return false;
        IntPtr desktop = OpenInputDesktop(0, false, DesktopReadObjects);
        if (desktop == IntPtr.Zero) return false;
        try
        {
            var name = new StringBuilder(128);
            return GetObjectName(desktop, 2, name, name.Capacity * 2, out needed)
                && needed <= name.Capacity * 2 && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { CloseDesktop(desktop); }
    }

    // Match shared/app-observation.ts by Unicode code point, not UTF-16 code unit.
    private static bool Forbidden(int code)
    {
        return code <= 31 || (code >= 127 && code <= 159) || code == 0xad || code == 0x61c || code == 0x180e
            || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
            || (code >= 0x2060 && code <= 0x206f) || (code >= 0xd800 && code <= 0xdfff) || code == 0xfeff;
    }
    private static bool TrimSpace(int code)
    {
        // ECMAScript String.trim whitespace, deliberately not .NET's different Trim set.
        return (code >= 9 && code <= 13) || code == 0x20 || code == 0xa0 || code == 0x1680
            || (code >= 0x2000 && code <= 0x200a) || code == 0x2028 || code == 0x2029
            || code == 0x202f || code == 0x205f || code == 0x3000 || code == 0xfeff;
    }
    internal static bool IsValidName(string name)
    {
        if (String.IsNullOrEmpty(name) || name == "." || name == ".."
            || TrimSpace(name[0]) || TrimSpace(name[name.Length - 1])) return false;
        int points = 0, bytes = 0;
        for (int index = 0; index < name.Length; index++)
        {
            int code = name[index];
            if (Char.IsHighSurrogate(name[index]) && index + 1 < name.Length && Char.IsLowSurrogate(name[index + 1]))
            {
                code = Char.ConvertToUtf32(name[index], name[index + 1]);
                index++;
            }
            if (Forbidden(code) || (code <= 0xffff && "\\/:*?\"<>|".IndexOf((char)code) >= 0)) return false;
            points++; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (points > 96 || bytes > 384) return false;
        }
        return true;
    }

    private static readonly Dictionary<string, string> KnownNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { "Code", "Visual Studio Code" }, { "Code - Insiders", "Visual Studio Code Insiders" },
        { "chrome", "Google Chrome" }, { "msedge", "Microsoft Edge" }, { "firefox", "Mozilla Firefox" },
        { "notepad", "Notepad" }, { "WindowsTerminal", "Windows Terminal" },
        { "AI Project Hub", "AI Project Hub" }, { "ai-project-hub", "AI Project Hub" }
    };
    private static readonly HashSet<string> AmbiguousHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ApplicationFrameHost", "RuntimeBroker", "WWAHost", "dllhost", "svchost", "taskhostw"
    };

    private static string ReadName(IntPtr requiredWindow)
    {
        if (!InteractiveDefaultDesktop()) return null;
        IntPtr window = GetForegroundWindow();
        // The native smoke passes its own live HWND. This extra restriction occurs
        // before even reading a PID; production passes zero and has no test switch.
        if (window == IntPtr.Zero || (requiredWindow != IntPtr.Zero && window != requiredWindow)) return null;
        uint processId;
        if (GetWindowThreadProcessId(window, out processId) == 0 || processId == 0) return null;
        IntPtr process = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            var buffer = new StringBuilder(261);
            uint length = K32GetModuleBaseNameW(process, IntPtr.Zero, buffer, (uint)buffer.Capacity);
            if (length == 0 || length >= buffer.Capacity - 1) return null; // Never accept a truncated label.
            uint currentId;
            if (!InteractiveDefaultDesktop() || GetForegroundWindow() != window
                || GetWindowThreadProcessId(window, out currentId) == 0 || currentId != processId) return null;
            string name = buffer.ToString();
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            // No trimming, truncation, character deletion, title-based guessing, or UWP host inference.
            if (!IsValidName(name) || AmbiguousHosts.Contains(name)) return null;
            string known;
            return KnownNames.TryGetValue(name, out known) ? known : name;
        }
        finally { CloseHandle(process); }
    }

    internal static string Observe(IntPtr requiredWindow)
    {
        string name = null;
        try { name = ReadName(requiredWindow); } catch { /* Ordinary native inability is an unknown observation. */ }
        return new JavaScriptSerializer().Serialize(new Dictionary<string, object>
        {
            { "name", name }, { "observedAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) }
        });
    }

    private static int Main()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false, true);
            Console.Write(Observe(IntPtr.Zero));
            return 0;
        }
        catch { return 1; } // No stderr, exception text, paths or identifiers.
    }
}
