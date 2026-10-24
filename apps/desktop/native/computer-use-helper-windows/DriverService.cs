using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Goat.ComputerUse
{
    internal sealed class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code, string message) : base(message) { Code = code; }
    }

    /// <summary>
    /// Owns exactly one Cua Driver daemon, and runs the driver for nothing else but the short app
    /// listing GOAT's capability manifest needs. Every run uses the files this build pinned by
    /// SHA-256, inside a job that ends it with the helper.
    /// </summary>
    internal sealed class DriverService
    {
        static readonly Regex PipeName = new Regex(@"^\\\\\.\\pipe\\goat-cu-[A-Za-z0-9-]{1,64}$");

        /// <summary>Names the driver inherits: the Windows session basics. Anything else is dropped.</summary>
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
            new[] { "CUA_TELEMETRY", "0" },
        };
        const int ListAppsTimeoutMs = 15000;

        readonly object gate = new object();
        readonly string executablePath;
        readonly Action<Dictionary<string, object>> emit;
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        int driverPid;
        int generation;
        SafeFileHandle liveness;
        readonly List<IDisposable> pins = new List<IDisposable>();
        string driverDirectory;

        public DriverService(string executablePath, Action<Dictionary<string, object>> emit)
        {
            this.executablePath = executablePath;
            this.emit = emit;
        }

        /// <summary>
        /// Pins the driver: opens the helper's folder, the driver folder and every pinned file,
        /// requires each to resolve to the path the helper itself runs from (no link or junction
        /// anywhere on the way), checks each file's hash, and keeps all of them open. Open
        /// directories cannot be renamed or replaced and open files cannot be written or
        /// deleted, so the paths the driver later starts from name exactly these bytes.
        /// </summary>
        void PinDriverFiles()
        {
            if (pins.Count > 0) return;
            try
            {
                string self;
                using (var own = new FileStream(executablePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
                    self = FinalPath(own.SafeFileHandle);
                string helperDirectory = Path.GetDirectoryName(self);
                string drivers = Path.Combine(helperDirectory, "cua-driver");
                foreach (string directory in new[] { helperDirectory, drivers })
                {
                    SafeFileHandle handle = NativeMethods.CreateFileW(directory, NativeMethods.FILE_READ_ATTRIBUTES,
                        NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE, IntPtr.Zero, NativeMethods.OPEN_EXISTING,
                        NativeMethods.FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
                    if (handle.IsInvalid) throw new HelperException("driver_missing", "The helper's driver folder is missing.");
                    pins.Add(handle);
                    if (!SamePath(FinalPath(handle), directory))
                        throw new HelperException("driver_untrusted", "The helper's driver folder is reached through a link.");
                }
                foreach (KeyValuePair<string, string> pin in BuildInfo.PinnedFiles)
                {
                    string path = Path.Combine(drivers, pin.Key);
                    if (!File.Exists(path)) throw new HelperException("driver_missing", "The helper has no " + pin.Key + ".");
                    var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                    pins.Add(stream);
                    if (!SamePath(FinalPath(stream.SafeFileHandle), path))
                        throw new HelperException("driver_untrusted", pin.Key + " is reached through a link.");
                    string actual;
                    using (var sha = SHA256.Create()) actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    if (actual != pin.Value)
                        throw new HelperException("driver_untrusted", pin.Key + " does not match the Cua Driver this helper was built with.");
                }
                driverDirectory = drivers;
            }
            catch
            {
                ReleasePins();
                throw;
            }
        }

        static string FinalPath(SafeFileHandle handle)
        {
            var name = new StringBuilder(1024);
            int length = NativeMethods.GetFinalPathNameByHandleW(handle, name, name.Capacity, 0);
            if (length <= 0 || length >= name.Capacity) throw new HelperException("driver_untrusted", "The helper cannot resolve its own files.");
            string path = name.ToString();
            return path.StartsWith(@"\\?\UNC\") ? @"\\" + path.Substring(8) : path.StartsWith(@"\\?\") ? path.Substring(4) : path;
        }

        static bool SamePath(string a, string b)
        {
            return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        void ReleasePins()
        {
            foreach (IDisposable pin in pins) pin.Dispose();
            pins.Clear();
            driverDirectory = null;
        }

        string DriverExecutable { get { return Path.Combine(driverDirectory, "cua-driver.exe"); } }

        public Dictionary<string, object> Start(Dictionary<string, object> parameters)
        {
            lock (gate)
            {
                if (process != IntPtr.Zero) throw new HelperException("already_running", "The driver is already running.");
                RequireUsableSession();
                string socketPath = parameters.ContainsKey("socketPath") ? parameters["socketPath"] as string : null;
                if (socketPath == null || !PipeName.IsMatch(socketPath))
                    throw new HelperException("bad_request", @"socketPath must be a pipe named \\.\pipe\goat-cu-<id>.");
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
                    job = CreateJob();
                    var security = Inheritable();
                    SafeFileHandle readEnd;
                    if (!NativeMethods.CreatePipe(out readEnd, out liveness, ref security, 0)) throw NativeMethods.LastError("CreatePipe");
                    NativeMethods.SetHandleInformation(liveness, NativeMethods.HANDLE_FLAG_INHERIT, 0);
                    using (readEnd)
                    using (SafeFileHandle nul = Nul())
                    {
                        var environment = DriverEnvironment(parameters);
                        environment["CUA_DRIVER_EMBEDDED"] = "1";
                        environment["CUA_DRIVER_EMBEDDED_HOST_PID"] = System.Diagnostics.Process.GetCurrentProcess().Id.ToString();
                        process = Launch(job, arguments, environment, readEnd, nul, out driverPid);
                    }
                    int started = ++generation;
                    IntPtr watched = Duplicate(process);
                    int watchedPid = driverPid;
                    var watcher = new Thread(delegate () { WatchExit(watched, watchedPid, started); });
                    watcher.IsBackground = true;
                    watcher.Start();
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

        static void RequireUsableSession()
        {
            Dictionary<string, object> readiness = WindowsFacts.Readiness();
            if (!(bool)readiness["interactiveSession"])
                throw new HelperException("no_interactive_desktop",
                    "This GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Computer use needs GOAT started from a signed-in desktop.");
            if ((bool)readiness["helperElevated"])
                throw new HelperException("helper_elevated", "GOAT Computer Use does not run elevated. Start GOAT without Run as administrator.");
        }

        /// <summary>
        /// The driver's list_apps, which GOAT's capability manifest is built from, read through
        /// the pinned driver in a job of its own. GOAT never runs the driver outside the helper.
        /// </summary>
        public object ListApps()
        {
            lock (gate)
            {
                RequireUsableSession();
                bool pinnedHere = pins.Count == 0;
                PinDriverFiles();
                IntPtr listJob = IntPtr.Zero;
                IntPtr child = IntPtr.Zero;
                try
                {
                    listJob = CreateJob();
                    var security = Inheritable();
                    SafeFileHandle inRead, inWrite, outRead, outWrite;
                    if (!NativeMethods.CreatePipe(out inRead, out inWrite, ref security, 0)) throw NativeMethods.LastError("CreatePipe");
                    if (!NativeMethods.CreatePipe(out outRead, out outWrite, ref security, 0)) throw NativeMethods.LastError("CreatePipe");
                    NativeMethods.SetHandleInformation(inWrite, NativeMethods.HANDLE_FLAG_INHERIT, 0);
                    NativeMethods.SetHandleInformation(outRead, NativeMethods.HANDLE_FLAG_INHERIT, 0);
                    int pid;
                    using (inRead)
                    using (outWrite)
                        child = Launch(listJob, new List<string> { "mcp" }, DriverEnvironment(new Dictionary<string, object>()), inRead, outWrite, out pid);
                    using (var input = new FileStream(inWrite, FileAccess.Write))
                    using (var output = new FileStream(outRead, FileAccess.Read))
                        return ExchangeListApps(input, output);
                }
                finally
                {
                    if (listJob != IntPtr.Zero) { NativeMethods.TerminateJobObject(listJob, 0); NativeMethods.CloseHandle(listJob); }
                    if (child != IntPtr.Zero) NativeMethods.CloseHandle(child);
                    if (pinnedHere && process == IntPtr.Zero) ReleasePins();
                }
            }
        }

        static object ExchangeListApps(Stream input, Stream output)
        {
            var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            var lines = new BlockingCollection<string>();
            var reader = new Thread(delegate ()
            {
                try
                {
                    var text = new StreamReader(output, new UTF8Encoding(false));
                    string line;
                    while ((line = text.ReadLine()) != null) lines.Add(line);
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                lines.CompleteAdding();
            });
            reader.IsBackground = true;
            reader.Start();
            Action<string> send = delegate (string message)
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(message + "\n");
                input.Write(bytes, 0, bytes.Length);
                input.Flush();
            };
            send("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"goat\",\"version\":\"1\"}}}");
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(ListAppsTimeoutMs);
            while (true)
            {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                string line;
                if (remaining <= 0 || !lines.TryTake(out line, remaining))
                    throw new HelperException(lines.IsAddingCompleted ? "list_failed" : "list_timeout", "Cua Driver did not list apps.");
                Dictionary<string, object> message = null;
                try { message = json.DeserializeObject(line) as Dictionary<string, object>; }
                catch (ArgumentException) { }
                object id;
                if (message == null || !message.TryGetValue("id", out id)) continue;
                if (Convert.ToInt32(id) == 1)
                {
                    send("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
                    send("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_apps\",\"arguments\":{}}}");
                    continue;
                }
                if (Convert.ToInt32(id) != 2) continue;
                object result, structured, apps;
                if (message.TryGetValue("result", out result) && result is Dictionary<string, object> &&
                    ((Dictionary<string, object>)result).TryGetValue("structuredContent", out structured) &&
                    structured is Dictionary<string, object> &&
                    ((Dictionary<string, object>)structured).TryGetValue("apps", out apps) && apps is object[])
                {
                    // The same answer as the macOS helper's listApps, plus each running app's
                    // executable as Windows reports it for that pid. The driver lists a running
                    // program without a Start menu entry with no bundle id at all, so without
                    // its path GOAT's manifest could never admit it (#1368); a path grant is
                    // matched against the executable the driver attests for the window.
                    foreach (object entry in (object[])apps)
                    {
                        var app = entry as Dictionary<string, object>;
                        object pid;
                        if (app == null || app.ContainsKey("executable") || !app.TryGetValue("pid", out pid) || !(pid is int) || (int)pid <= 0) continue;
                        string executable = ImagePath((int)pid);
                        if (executable != null) app["executable"] = executable;
                    }
                    var listed = new Dictionary<string, object>();
                    listed["apps"] = apps;
                    return listed;
                }
                throw new HelperException("list_failed", "Cua Driver could not list apps.");
            }
        }

        /// <summary>
        /// The final path of a running process's image file, as the driver attests it: it
        /// resolves links, junctions and short names (Rust's fs::canonicalize, which is
        /// GetFinalPathNameByHandle on an opened file), so the helper does the same. Null when
        /// Windows will not say or the file will not open; that app then stays out.
        /// </summary>
        static string ImagePath(int pid)
        {
            IntPtr process = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            string reported;
            try
            {
                var name = new StringBuilder(1024);
                int size = name.Capacity;
                if (!NativeMethods.QueryFullProcessImageNameW(process, 0, name, ref size)) return null;
                reported = name.ToString();
            }
            finally { NativeMethods.CloseHandle(process); }
            using (SafeFileHandle file = NativeMethods.CreateFileW(reported, NativeMethods.FILE_READ_ATTRIBUTES,
                NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE | 4, IntPtr.Zero, NativeMethods.OPEN_EXISTING,
                NativeMethods.FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
            {
                if (file.IsInvalid) return null;
                try { return FinalPath(file); }
                catch (HelperException) { return null; }
            }
        }

        static NativeMethods.SECURITY_ATTRIBUTES Inheritable()
        {
            return new NativeMethods.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(NativeMethods.SECURITY_ATTRIBUTES)), bInheritHandle = true };
        }

        static SafeFileHandle Nul()
        {
            SafeFileHandle nul = NativeMethods.CreateFileW("NUL", NativeMethods.GENERIC_WRITE, 3, IntPtr.Zero, NativeMethods.OPEN_EXISTING, 0, IntPtr.Zero);
            NativeMethods.SetHandleInformation(nul, NativeMethods.HANDLE_FLAG_INHERIT, NativeMethods.HANDLE_FLAG_INHERIT);
            return nul;
        }

        static IntPtr CreateJob()
        {
            IntPtr created = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
            if (created == IntPtr.Zero) throw NativeMethods.LastError("CreateJobObject");
            var limits = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | NativeMethods.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if (!NativeMethods.SetInformationJobObject(created, NativeMethods.JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)))
            {
                NativeMethods.CloseHandle(created);
                throw NativeMethods.LastError("SetInformationJobObject");
            }
            return created;
        }

        static IntPtr Duplicate(IntPtr handle)
        {
            IntPtr self = NativeMethods.GetCurrentProcess();
            IntPtr copy;
            if (!NativeMethods.DuplicateHandle(self, handle, self, out copy, 0, false, NativeMethods.DUPLICATE_SAME_ACCESS))
                throw NativeMethods.LastError("DuplicateHandle");
            return copy;
        }

        static SortedDictionary<string, string> DriverEnvironment(Dictionary<string, object> parameters)
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
        /// Starts the pinned driver suspended, puts it in the job, then lets it run, so no process
        /// it starts can escape the job. A child the job refuses is ended before it ever runs.
        /// Only stdin, stdout and stderr are inherited.
        /// </summary>
        IntPtr Launch(IntPtr intoJob, List<string> arguments, SortedDictionary<string, string> environment,
            SafeFileHandle stdin, SafeFileHandle stdout, out int pid)
        {
            string executable = DriverExecutable;
            IntPtr stderr = NativeMethods.GetStdHandle(-12);
            var block = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in environment) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            block.Append('\0');
            IntPtr environmentBlock = Marshal.StringToHGlobalUni(block.ToString());
            var handles = new List<IntPtr> { stdin.DangerousGetHandle(), stdout.DangerousGetHandle() };
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
                startup.StartupInfo.hStdInput = stdin.DangerousGetHandle();
                startup.StartupInfo.hStdOutput = stdout.DangerousGetHandle();
                startup.StartupInfo.hStdError = stderrInheritable ? stderr : stdout.DangerousGetHandle();
                startup.lpAttributeList = attributes;
                var commandLine = new StringBuilder(Quote(executable));
                foreach (string argument in arguments) commandLine.Append(' ').Append(Quote(argument));
                NativeMethods.PROCESS_INFORMATION info;
                if (!NativeMethods.CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                        NativeMethods.CREATE_SUSPENDED | NativeMethods.CREATE_UNICODE_ENVIRONMENT | NativeMethods.CREATE_NO_WINDOW | NativeMethods.EXTENDED_STARTUPINFO_PRESENT,
                        environmentBlock, driverDirectory, ref startup, out info))
                    throw new HelperException("spawn_failed", "Could not start Cua Driver (" + Marshal.GetLastWin32Error() + ").");
                if (!NativeMethods.AssignProcessToJobObject(intoJob, info.hProcess))
                {
                    int error = Marshal.GetLastWin32Error();
                    // Never resumed, so it has run no code; end it before anyone can.
                    NativeMethods.TerminateProcess(info.hProcess, 1);
                    NativeMethods.WaitForSingleObject(info.hProcess, 5000);
                    NativeMethods.CloseHandle(info.hThread);
                    NativeMethods.CloseHandle(info.hProcess);
                    throw new HelperException("spawn_failed", "Could not contain Cua Driver in the helper's job (" + error + ").");
                }
                NativeMethods.ResumeThread(info.hThread);
                NativeMethods.CloseHandle(info.hThread);
                pid = info.dwProcessId;
                return info.hProcess;
            }
            finally
            {
                NativeMethods.DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
                Marshal.FreeHGlobal(handleArray);
                Marshal.FreeHGlobal(environmentBlock);
            }
        }

        /// <summary>
        /// Ready once the pipe exists and the process serving it is the driver this helper
        /// started. Later connections are not re-checked: any process that could serve a rogue
        /// instance runs as this user and could already drive GOAT itself (#1210).
        /// </summary>
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

        /// <summary>Waits on its own copy of the handle; a stop or restart since then makes it stale.</summary>
        void WatchExit(IntPtr watched, int watchedPid, int startedGeneration)
        {
            NativeMethods.WaitForSingleObject(watched, 0xFFFFFFFF);
            uint code;
            NativeMethods.GetExitCodeProcess(watched, out code);
            NativeMethods.CloseHandle(watched);
            lock (gate)
            {
                // An orderly stop clears the process first and stays silent.
                if (startedGeneration != generation || process == IntPtr.Zero) return;
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
            generation++;
            if (liveness != null) { liveness.Dispose(); liveness = null; }
            // Closing the last job handle kills anything the driver left behind.
            if (job != IntPtr.Zero) { NativeMethods.CloseHandle(job); job = IntPtr.Zero; }
            if (process != IntPtr.Zero) { NativeMethods.CloseHandle(process); process = IntPtr.Zero; }
            driverPid = 0;
            ReleasePins();
        }
    }
}
