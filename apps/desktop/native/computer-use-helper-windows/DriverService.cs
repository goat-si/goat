using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Goat.ComputerUse
{
    internal sealed class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code, string message) : base(message) { Code = code; }
    }

    /// <summary>
    /// Owns exactly one Cua Driver daemon. The driver runs from the files this build pinned by
    /// SHA-256, inside a job that ends it with the helper, and is ready only once the pipe it
    /// serves is provably its own.
    /// </summary>
    internal sealed class DriverService
    {
        static readonly Regex PipeName = new Regex(@"^\\\\\.\\pipe\\goat-cu-[A-Za-z0-9-]{1,64}$");

        /// <summary>Names the daemon inherits: the Windows session basics. Anything else is dropped.</summary>
        static readonly string[] InheritedNames =
        {
            "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP",
            "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
            "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE", "OS", "LANG", "CUA_LOG",
        };
        /// <summary>Driver tuning the host may set at launch. No tool argument can change these.</summary>
        static readonly HashSet<string> HostSettableNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS", "CUA_DRIVER_WINDOW_CHANGE_POLL_MS", "CUA_DRIVER_KEY_GAP_MS", "CUA_LOG",
        };
        /// <summary>Telemetry and the GitHub update check stay off whatever the host or user set.</summary>
        static readonly string[][] PrivacyEnvironment =
        {
            new[] { "CUA_DRIVER_RS_TELEMETRY_ENABLED", "false" },
            new[] { "CUA_TELEMETRY_ENABLED", "false" },
            new[] { "CUA_DRIVER_RS_UPDATE_CHECK", "false" },
            new[] { "DO_NOT_TRACK", "1" },
        };

        readonly object gate = new object();
        readonly string helperDirectory;
        readonly Action<Dictionary<string, object>> emit;
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        int driverPid;
        SafeFileHandle liveness;
        readonly List<FileStream> pinnedHandles = new List<FileStream>();

        public DriverService(string helperDirectory, Action<Dictionary<string, object>> emit)
        {
            this.helperDirectory = helperDirectory;
            this.emit = emit;
        }

        string DriverDirectory { get { return Path.Combine(helperDirectory, "cua-driver"); } }

        /// <summary>
        /// Opens every pinned file without write or delete sharing and checks its hash. The
        /// handles stay open while the driver runs, so nobody can swap a file between this check
        /// and the loader reading it.
        /// </summary>
        void PinDriverFiles()
        {
            if (IsReparsePoint(helperDirectory) || IsReparsePoint(DriverDirectory))
                throw new HelperException("driver_untrusted", "The helper's driver folder is a link.");
            foreach (KeyValuePair<string, string> pin in BuildInfo.PinnedFiles)
            {
                string path = Path.Combine(DriverDirectory, pin.Key);
                if (!File.Exists(path) || IsReparsePoint(path))
                    throw new HelperException("driver_missing", "The helper has no " + pin.Key + ".");
                var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                pinnedHandles.Add(stream);
                string actual;
                using (var sha = SHA256.Create()) actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (actual != pin.Value)
                    throw new HelperException("driver_untrusted", pin.Key + " does not match the Cua Driver this helper was built with.");
            }
        }

        static bool IsReparsePoint(string path)
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }

        void ReleasePins()
        {
            foreach (FileStream stream in pinnedHandles) stream.Dispose();
            pinnedHandles.Clear();
        }

        public Dictionary<string, object> Start(Dictionary<string, object> parameters)
        {
            lock (gate)
            {
                if (process != IntPtr.Zero) throw new HelperException("already_running", "The driver is already running.");
                Dictionary<string, object> readiness = WindowsFacts.Readiness();
                if (!(bool)readiness["interactiveSession"])
                    throw new HelperException("no_interactive_desktop",
                        "This GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Computer use needs GOAT started from a signed-in desktop.");
                if ((bool)readiness["helperElevated"])
                    throw new HelperException("helper_elevated", "GOAT Computer Use does not run elevated. Start GOAT without Run as administrator.");
                string socketPath = parameters.ContainsKey("socketPath") ? parameters["socketPath"] as string : null;
                if (socketPath == null || !PipeName.IsMatch(socketPath))
                    throw new HelperException("bad_request", "socketPath must be a pipe named \\\\.\\pipe\\goat-cu-<id>.");
                if (NativeMethods.WaitNamedPipeW(socketPath, 1) || Marshal.GetLastWin32Error() != NativeMethods.ERROR_FILE_NOT_FOUND)
                    throw new HelperException("socket_in_use", "Something already serves that pipe.");

                var arguments = new List<string>
                {
                    "serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate", "--socket", socketPath,
                    "--host-bundle-id", BuildInfo.HelperId, "--permission-mode", "standard",
                };
                object manifest;
                if (parameters.TryGetValue("capabilityManifestPath", out manifest) && manifest != null)
                {
                    string manifestPath = manifest as string;
                    if (manifestPath == null || !Path.IsPathRooted(manifestPath) || manifestPath.StartsWith(@"\\"))
                        throw new HelperException("bad_request", "capabilityManifestPath must be an absolute local path.");
                    arguments.Add("--capability-manifest");
                    arguments.Add(manifestPath);
                    arguments.Add("--approve-capability-manifest");
                }
                object noOverlay;
                if (parameters.TryGetValue("noOverlay", out noOverlay) && noOverlay is bool && (bool)noOverlay) arguments.Add("--no-overlay");

                try
                {
                    PinDriverFiles();
                    Spawn(arguments, Environment(parameters));
                    WaitUntilServing(socketPath);
                }
                catch
                {
                    StopLocked();
                    throw;
                }
                var result = new Dictionary<string, object>();
                result["socketPath"] = socketPath;
                result["driverPid"] = driverPid;
                result["hostBundleId"] = BuildInfo.HelperId;
                return result;
            }
        }

        static SortedDictionary<string, string> Environment(Dictionary<string, object> parameters)
        {
            var environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string name in InheritedNames)
            {
                string value = System.Environment.GetEnvironmentVariable(name);
                if (value != null) environment[name] = value;
            }
            object entries;
            if (parameters.TryGetValue("environment", out entries) && entries is object[])
            {
                foreach (object entry in (object[])entries)
                {
                    var pair = entry as Dictionary<string, object>;
                    if (pair == null) continue;
                    string name = pair.ContainsKey("name") ? pair["name"] as string : null;
                    string value = pair.ContainsKey("value") ? pair["value"] as string : null;
                    if (name != null && value != null && HostSettableNames.Contains(name)) environment[name] = value;
                }
            }
            foreach (string[] pair in PrivacyEnvironment) environment[pair[0]] = pair[1];
            environment["CUA_DRIVER_EMBEDDED"] = "1";
            environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = System.Diagnostics.Process.GetCurrentProcess().Id.ToString();
            return environment;
        }

        static string Quote(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
            var quoted = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') quoted.Append('\\', backslashes * 2 + 1);
                else quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(c);
            }
            quoted.Append('\\', backslashes * 2);
            return quoted.Append('"').ToString();
        }

        /// <summary>
        /// Starts the driver suspended, puts it in a kill-on-close job, then lets it run, so no
        /// process it starts can escape the job. Only the liveness pipe and stderr are inherited.
        /// </summary>
        void Spawn(List<string> arguments, SortedDictionary<string, string> environment)
        {
            string executable = Path.Combine(DriverDirectory, "cua-driver.exe");
            job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw NativeMethods.LastError("CreateJobObject");
            var limits = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | NativeMethods.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if (!NativeMethods.SetInformationJobObject(job, NativeMethods.JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)))
                throw NativeMethods.LastError("SetInformationJobObject");

            var security = new NativeMethods.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(NativeMethods.SECURITY_ATTRIBUTES)), bInheritHandle = true };
            SafeFileHandle readEnd;
            if (!NativeMethods.CreatePipe(out readEnd, out liveness, ref security, 0)) throw NativeMethods.LastError("CreatePipe");
            NativeMethods.SetHandleInformation(liveness, NativeMethods.HANDLE_FLAG_INHERIT, 0);
            SafeFileHandle nul = NativeMethods.CreateFileW("NUL", NativeMethods.GENERIC_WRITE, 3, IntPtr.Zero, NativeMethods.OPEN_EXISTING, 0, IntPtr.Zero);
            NativeMethods.SetHandleInformation(nul, NativeMethods.HANDLE_FLAG_INHERIT, NativeMethods.HANDLE_FLAG_INHERIT);
            IntPtr stderr = NativeMethods.GetStdHandle(-12);

            var block = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in environment) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            block.Append('\0');
            IntPtr environmentBlock = Marshal.StringToHGlobalUni(block.ToString());

            var handles = new List<IntPtr> { readEnd.DangerousGetHandle(), nul.DangerousGetHandle() };
            bool stderrInheritable = stderr != IntPtr.Zero && stderr != new IntPtr(-1);
            if (stderrInheritable) handles.Add(stderr);
            IntPtr handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
            for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, handles[i]);
            IntPtr size = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            IntPtr attributes = Marshal.AllocHGlobal(size);
            try
            {
                if (!NativeMethods.InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw NativeMethods.LastError("InitializeProcThreadAttributeList");
                if (!NativeMethods.UpdateProcThreadAttribute(attributes, 0, NativeMethods.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleArray,
                        (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero))
                    throw NativeMethods.LastError("UpdateProcThreadAttribute");
                var startup = new NativeMethods.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFOEX));
                startup.StartupInfo.dwFlags = NativeMethods.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = readEnd.DangerousGetHandle();
                startup.StartupInfo.hStdOutput = nul.DangerousGetHandle();
                startup.StartupInfo.hStdError = stderrInheritable ? stderr : nul.DangerousGetHandle();
                startup.lpAttributeList = attributes;
                var commandLine = new StringBuilder(Quote(executable));
                foreach (string argument in arguments) commandLine.Append(' ').Append(Quote(argument));
                NativeMethods.PROCESS_INFORMATION info;
                if (!NativeMethods.CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                        NativeMethods.CREATE_SUSPENDED | NativeMethods.CREATE_UNICODE_ENVIRONMENT | NativeMethods.CREATE_NO_WINDOW | NativeMethods.EXTENDED_STARTUPINFO_PRESENT,
                        environmentBlock, DriverDirectory, ref startup, out info))
                    throw new HelperException("spawn_failed", "Could not start Cua Driver (" + Marshal.GetLastWin32Error() + ").");
                process = info.hProcess;
                driverPid = info.dwProcessId;
                if (!NativeMethods.AssignProcessToJobObject(job, process))
                {
                    NativeMethods.CloseHandle(info.hThread);
                    throw new HelperException("spawn_failed", "Could not contain Cua Driver in the helper's job (" + Marshal.GetLastWin32Error() + ").");
                }
                NativeMethods.ResumeThread(info.hThread);
                NativeMethods.CloseHandle(info.hThread);
            }
            finally
            {
                NativeMethods.DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
                Marshal.FreeHGlobal(handleArray);
                Marshal.FreeHGlobal(environmentBlock);
                readEnd.Dispose();
                nul.Dispose();
            }
            IntPtr watched = process;
            int watchedPid = driverPid;
            var watcher = new Thread(delegate () { WatchExit(watched, watchedPid); });
            watcher.IsBackground = true;
            watcher.Start();
        }

        /// <summary>Ready once the pipe exists and the process serving it is the driver this helper started.</summary>
        void WaitUntilServing(string socketPath)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(20);
            while (DateTime.UtcNow < deadline)
            {
                if (NativeMethods.WaitForSingleObject(process, 0) == NativeMethods.WAIT_OBJECT_0)
                {
                    uint code;
                    NativeMethods.GetExitCodeProcess(process, out code);
                    throw new HelperException("exited_before_ready", "Cua Driver exited during startup (" + code + ").");
                }
                if (NativeMethods.WaitNamedPipeW(socketPath, 50))
                {
                    using (SafeFileHandle pipe = NativeMethods.CreateFileW(socketPath, NativeMethods.GENERIC_READ | NativeMethods.GENERIC_WRITE, 0, IntPtr.Zero, NativeMethods.OPEN_EXISTING, 0, IntPtr.Zero))
                    {
                        if (pipe.IsInvalid)
                        {
                            if (Marshal.GetLastWin32Error() == NativeMethods.ERROR_PIPE_BUSY) continue;
                            throw new HelperException("socket_untrusted", "The driver pipe could not be opened (" + Marshal.GetLastWin32Error() + ").");
                        }
                        uint server;
                        if (!NativeMethods.GetNamedPipeServerProcessId(pipe, out server) || server != (uint)driverPid)
                            throw new HelperException("socket_untrusted", "The driver pipe is served by another process.");
                        return;
                    }
                }
                // WaitNamedPipe returns at once while the pipe does not exist yet.
                if (Marshal.GetLastWin32Error() == NativeMethods.ERROR_FILE_NOT_FOUND) Thread.Sleep(50);
            }
            throw new HelperException("startup_timeout", "Cua Driver did not become ready within 20 seconds.");
        }

        void WatchExit(IntPtr watched, int watchedPid)
        {
            NativeMethods.WaitForSingleObject(watched, 0xFFFFFFFF);
            uint code;
            NativeMethods.GetExitCodeProcess(watched, out code);
            lock (gate)
            {
                // An orderly stop clears the process first and stays silent.
                if (process != watched) return;
                CleanUpLocked();
            }
            var exited = new Dictionary<string, object>();
            exited["type"] = "driverExited";
            exited["driverPid"] = watchedPid;
            exited["code"] = (long)code;
            emit(exited);
        }

        public void Stop()
        {
            lock (gate) StopLocked();
        }

        /// <summary>Closing the liveness pipe is the daemon's orderly shutdown; the job ends whatever is left.</summary>
        void StopLocked()
        {
            IntPtr running = process;
            if (liveness != null) liveness.Dispose();
            if (running != IntPtr.Zero && NativeMethods.WaitForSingleObject(running, 3000) != NativeMethods.WAIT_OBJECT_0 && job != IntPtr.Zero)
            {
                NativeMethods.TerminateJobObject(job, 1);
                NativeMethods.WaitForSingleObject(running, 2000);
            }
            CleanUpLocked();
        }

        void CleanUpLocked()
        {
            if (liveness != null) { liveness.Dispose(); liveness = null; }
            // Closing the last job handle kills anything the driver left behind.
            if (job != IntPtr.Zero) { NativeMethods.CloseHandle(job); job = IntPtr.Zero; }
            if (process != IntPtr.Zero) { NativeMethods.CloseHandle(process); process = IntPtr.Zero; }
            driverPid = 0;
            ReleasePins();
        }
    }
}
