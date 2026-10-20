using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// A job is assigned before the suspended child can run. The job, not its first
// process, is the unit of completion; an unverified exit never gets a receipt.
internal static class GitHost {
    const uint CREATE_SUSPENDED = 4, CREATE_NO_WINDOW = 0x08000000, STARTF_USESTDHANDLES = 0x100;
    const uint JOB_KILL_ON_CLOSE = 0x2000, HANDLE_INHERIT = 1, WAIT_TIMEOUT = 258;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static long outputBytes;
    static volatile bool exceeded, inputExceeded, inputDone;
    static IntPtr job;

    sealed class Manifest {
        public string executable { get; set; }
        public string[] args { get; set; }
        public string cwd { get; set; }
        public string result { get; set; }
        public string nonce { get; set; }
        public int timeoutMs { get; set; }
        public int maxOutputBytes { get; set; }
        public int maxInputBytes { get; set; }
    }
    sealed class Guard {
        public string url { get; set; }
        public string source { get; set; }
        public string targetRef { get; set; }
        public string old { get; set; }
        public string receipt { get; set; }
        public string nonce { get; set; }
    }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime, kernelTime, periodUser, periodKernel; public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static void Check(bool condition) { if (!condition) throw new IOException("Native supervision failed."); }
    static FileStream Stream(IntPtr handle, FileAccess access) { return new FileStream(new SafeFileHandle(handle, true), access, 8192, false); }
    static Thread Output(IntPtr handle, Stream target, int limit) {
        Thread thread = new Thread(() => {
            try {
                using (FileStream source = Stream(handle, FileAccess.Read)) {
                    byte[] bytes = new byte[8192]; int count;
                    while ((count = source.Read(bytes, 0, bytes.Length)) > 0) {
                        if (Interlocked.Add(ref outputBytes, count) > limit) { exceeded = true; continue; }
                        target.Write(bytes, 0, count); target.Flush();
                    }
                }
            } catch { exceeded = true; }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static Thread Input(IntPtr handle, int limit) {
        Thread thread = new Thread(() => {
            try {
                using (FileStream target = Stream(handle, FileAccess.Write)) {
                    Stream source = Console.OpenStandardInput(); byte[] bytes = new byte[8192]; int count; long total = 0;
                    while ((count = source.Read(bytes, 0, bytes.Length)) > 0) {
                        total += count; if (total > limit) { inputExceeded = true; break; }
                        target.Write(bytes, 0, count); target.Flush();
                    }
                }
            } catch { /* A child may close its input before the parent finishes. */ }
            finally { inputDone = true; }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static int Supervise(string filename) {
        Manifest spec = Json.Deserialize<Manifest>(File.ReadAllText(filename, Encoding.UTF8));
        Check(spec != null && Path.IsPathRooted(spec.executable) && Path.IsPathRooted(spec.cwd) && Path.IsPathRooted(spec.result));
        Check(spec.args != null && spec.nonce != null && spec.nonce.Length == 64 && spec.timeoutMs > 0 && spec.timeoutMs <= 120000 && spec.maxOutputBytes > 0 && spec.maxOutputBytes <= 33554432 && spec.maxInputBytes > 0 && spec.maxInputBytes <= 33554432);
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
        EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = JOB_KILL_ON_CLOSE;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
        IntPtr inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite;
        Check(CreatePipe(out inputRead, out inputWrite, ref security, 0));
        Check(CreatePipe(out outputRead, out outputWrite, ref security, 0));
        Check(CreatePipe(out errorRead, out errorWrite, ref security, 0));
        Check(SetHandleInformation(inputWrite, HANDLE_INHERIT, 0));
        Check(SetHandleInformation(outputRead, HANDLE_INHERIT, 0));
        Check(SetHandleInformation(errorRead, HANDLE_INHERIT, 0));
        STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), flags = (int)STARTF_USESTDHANDLES, stdin = inputRead, stdout = outputWrite, stderr = errorWrite };
        StringBuilder command = new StringBuilder(Quote(spec.executable));
        foreach (string arg in spec.args) { Check(arg != null && arg.IndexOf('\0') < 0); command.Append(' ').Append(Quote(arg)); }
        PROCESS_INFORMATION process;
        Check(CreateProcess(spec.executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, spec.cwd, ref startup, out process));
        try {
            if (!AssignProcessToJobObject(job, process.process)) {
                TerminateProcess(process.process, 125); WaitForSingleObject(process.process, 10000);
                throw new IOException("Cannot supervise child job.");
            }
            CloseHandle(inputRead); CloseHandle(outputWrite); CloseHandle(errorWrite);
            Thread output = Output(outputRead, Console.OpenStandardOutput(), spec.maxOutputBytes);
            Thread error = Output(errorRead, Console.OpenStandardError(), spec.maxOutputBytes);
            Input(inputWrite, spec.maxInputBytes);
            Check(ResumeThread(process.thread) != UInt32.MaxValue);
            Stopwatch clock = Stopwatch.StartNew(); bool stopped = false, timeout = false;
            long killAt = 0;
            while (true) {
                ACCOUNTING accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
                if (accounting.activeProcesses == 0) break;
                timeout = timeout || clock.ElapsedMilliseconds >= spec.timeoutMs;
                // Closing the supervisor's input is normal for finite commands. Only
                // the timeout/output limits terminate a still-live process group.
                if (!stopped && (timeout || exceeded || inputExceeded)) {
                    Check(TerminateJobObject(job, 124)); stopped = true; killAt = clock.ElapsedMilliseconds;
                }
                if (stopped && clock.ElapsedMilliseconds - killAt > 10000) throw new IOException("Job exit could not be verified.");
                Thread.Sleep(10);
            }
            Check(WaitForSingleObject(process.process, 1000) != WAIT_TIMEOUT);
            uint code; Check(GetExitCodeProcess(process.process, out code));
            Check(output.Join(5000) && error.Join(5000));
            string receipt = Json.Serialize(new { nonce = spec.nonce, exited = true, code = code, timedOut = timeout, outputExceeded = exceeded, inputExceeded = inputExceeded });
            using (FileStream file = new FileStream(spec.result, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] data = Encoding.UTF8.GetBytes(receipt); file.Write(data, 0, data.Length); file.Flush(true);
            }
            return 0;
        } finally { CloseHandle(process.thread); CloseHandle(process.process); CloseHandle(job); job = IntPtr.Zero; }
    }
    static int PushGuard(string[] args) {
        string filename = Environment.GetEnvironmentVariable("HUB_GIT_PUSH_GUARD");
        if (String.IsNullOrEmpty(filename) || !Path.IsPathRooted(filename) || new FileInfo(filename).Length > 16384) return 1;
        Guard expected = Json.Deserialize<Guard>(File.ReadAllText(filename, Encoding.UTF8));
        if (expected == null || args.Length != 2 || args[0] != expected.url || args[1] != expected.url || expected.nonce == null || expected.nonce.Length != 64) return 1;
        string input;
        using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) {
            char[] data = new char[8193]; int total = 0, count;
            while ((count = reader.Read(data, total, data.Length - total)) > 0) { total += count; if (total > 8192) return 1; }
            input = new string(data, 0, total);
        }
        string line = expected.source + " " + expected.source + " " + expected.targetRef + " " + expected.old + "\n";
        if (input != line) return 1;
        using (FileStream file = new FileStream(expected.receipt, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] bytes = Encoding.UTF8.GetBytes(expected.nonce); file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        return 0;
    }
    static int Main(string[] args) {
        try { return args.Length == 2 && args[0] == "--supervise" ? Supervise(args[1]) : PushGuard(args); }
        catch { return 125; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
