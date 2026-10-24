// Test-only entrypoint, compiled together with the exact production collector source.
// Only this form can be observed: the collector checks its live HWND before querying a PID.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ForegroundWindowFixture
{
    internal const string TitleSentinel = "HUB_FOREGROUND_PRIVATE_TITLE_SENTINEL";
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);

    [STAThread]
    private static int Main(string[] args)
    {
        bool interactive = args.Length == 1 && args[0] == "--interactive";
        try
        {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false, true);
            var serializer = new JavaScriptSerializer();
            var cases = serializer.Deserialize<List<Dictionary<string, object>>>(Console.In.ReadToEnd());
            int caseIndex = 0;
            foreach (var item in cases)
            {
                // Numeric UTF-16 units preserve lone-surrogate cases that the
                // Framework JSON deserializer would otherwise replace with U+FFFD.
                var units = (ArrayList)item["units"];
                var chars = new char[units.Count];
                for (int index = 0; index < units.Count; index++) chars[index] = (char)Convert.ToInt32(units[index]);
                if (ForegroundApp.IsValidName(new String(chars)) != (bool)item["valid"])
                {
                    Console.Write(caseIndex.ToString(CultureInfo.InvariantCulture));
                    return 3; // Only the controlled case index, never the input string.
                }
                caseIndex++;
            }

            int result = 2; // Focus could not be proved, not a mock success.
            using (var form = new Form())
            using (var timer = new Timer())
            {
                form.Text = "HelpTool foreground test - " + TitleSentinel;
                form.Width = 480; form.Height = 140;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.TopMost = interactive;
                form.Controls.Add(new Label { Text = "Please click this test window once. Verification is automatic; the window closes when finished.", Dock = DockStyle.Fill });
                int attempts = 0;
                timer.Interval = 100;
                timer.Tick += delegate
                {
                    if (++attempts > (interactive ? 450 : 40)) { form.Close(); return; }
                    if (GetForegroundWindow() != form.Handle) return;
                    try
                    {
                        string output = ForegroundApp.Observe(form.Handle);
                        var observation = serializer.Deserialize<Dictionary<string, object>>(output);
                        // A focus transition causes null, never observation of the replacement window.
                        if (observation["name"] == null) { result = 4; return; }
                        if (observation.Count != 2 || (string)observation["name"] != "HubForegroundFixture"
                            || !observation.ContainsKey("observedAt") || output.Contains(TitleSentinel))
                            throw new InvalidOperationException();
                        DateTime timestamp = DateTime.ParseExact((string)observation["observedAt"],
                            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
                        if (Math.Abs((DateTime.UtcNow - timestamp.ToUniversalTime()).TotalSeconds) > 5)
                            throw new InvalidOperationException();
                        // Invalid required HWND clears the name before any process metadata lookup.
                        var unknown = serializer.Deserialize<Dictionary<string, object>>(ForegroundApp.Observe(new IntPtr(-1)));
                        if (unknown.Count != 2 || unknown["name"] != null) throw new InvalidOperationException();
                        Console.Write(output);
                        result = 0;
                    }
                    catch { result = 1; }
                    form.Close();
                };
                form.Shown += delegate
                {
                    form.Activate();
                    SetForegroundWindow(form.Handle); // Never attach to or focus another application's window.
                    timer.Start();
                };
                Application.Run(form);
            }
            return result;
        }
        catch { return 1; }
    }
}
