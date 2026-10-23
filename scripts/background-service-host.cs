using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Built as WinExe: neither this owner nor its node child owns a console window.
internal static class BackgroundServiceHost
{
    private const uint KillOnJobClose = 0x00002000;
    private static string logDirectory;
    private static readonly int HostPid = Process.GetCurrentProcess().Id;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    // Windows command-line quoting, including trailing slashes before a quote.
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char item in value)
        {
            if (item == '\\') { slashes++; continue; }
            if (item == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            slashes = 0;
            result.Append(item);
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static string Absolute(Dictionary<string, object> config, string key)
    {
        object value;
        if (!config.TryGetValue(key, out value) || !(value is string) || !Path.IsPathRooted((string)value))
            throw new InvalidDataException("invalid_config");
        return Path.GetFullPath((string)value);
    }

    private static async Task Drain(StreamReader stream)
    {
        // Discard both streams without retaining their content or growing memory.
        var buffer = new char[4096];
        while (await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false) != 0) { }
    }

    private static void Record(string status, int? childPid, int? exitCode)
    {
        if (logDirectory == null) return;
        try
        {
            var record = new Dictionary<string, object> {
                {"at", DateTime.UtcNow.ToString("o")}, {"pid", HostPid},
                {"childPid", childPid}, {"status", status}, {"exitCode", exitCode}
            };
            string line = new JavaScriptSerializer().Serialize(record) + Environment.NewLine;
            string path = Path.Combine(logDirectory, "host-events.jsonl");
            if (File.Exists(path) && new FileInfo(path).Length + Encoding.UTF8.GetByteCount(line) > 1024 * 1024)
            {
                string previous = path + ".1";
                if (File.Exists(previous)) File.Delete(previous);
                File.Move(path, previous);
            }
            File.AppendAllText(path, line, new UTF8Encoding(false));
        }
        catch { /* Diagnostics must not interrupt an owned service. */ }
    }

    private static int Main(string[] args)
    {
        Process child = null;
        IntPtr job = IntPtr.Zero;
        string phase = "configuration_failed";
        int? childPid = null;
        try
        {
            if (args.Length != 2 || args[0] != "--config" || !Path.IsPathRooted(args[1])) return 3;
            string configPath = Path.GetFullPath(args[1]);
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
            string root = Absolute(config, "root");
            string node = Absolute(config, "nodeBinary");
            logDirectory = Path.Combine(Absolute(config, "dataDir"), "background-services");
            Directory.CreateDirectory(logDirectory);
            string entry = Path.Combine(root, "scripts", "background-service-entry.mjs");
            if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException();
            Record("host_started", null, null);

            phase = "job_create_failed";
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException();
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                throw new InvalidOperationException();

            phase = "child_start_failed";
            var start = new ProcessStartInfo(node, Quote(entry) + " --config " + Quote(configPath));
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            child = Process.Start(start);
            childPid = child.Id;
            Task stdout = Drain(child.StandardOutput);
            Task stderr = Drain(child.StandardError);
            phase = "job_assignment_failed";
            // The entry waits for stdin, so it cannot create descendants before
            // the JobObject owns it. An assignment failure never runs services.
            if (!AssignProcessToJobObject(job, child.Handle)) throw new InvalidOperationException();
            phase = "child_release_failed";
            child.StandardInput.WriteLine("start");
            child.StandardInput.Close();
            Record("child_started_in_job", childPid, null);
            phase = "child_wait_failed";
            child.WaitForExit();
            Task.WaitAll(stdout, stderr);
            int result = child.ExitCode;
            Record("child_exited", childPid, result);
            return result;
        }
        catch
        {
            Record(phase, childPid, 3);
            // Only the exact newly created child may be cleaned up here.
            if (child != null)
            {
                try { if (!child.HasExited) { child.Kill(); child.WaitForExit(5000); } } catch { }
            }
            return 3;
        }
        finally
        {
            // A host crash also closes this kernel handle and stops its owned
            // process tree. Reused external services were never in this job.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child != null) child.Dispose();
        }
    }
}
