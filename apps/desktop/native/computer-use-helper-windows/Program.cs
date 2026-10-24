// GOAT Computer Use helper (Windows).
//
// GOAT's desktop host starts this executable with stdio pipes from the signed-in user's
// session. It speaks the same line-delimited JSON as the macOS helper
// (apps/desktop/native/computer-use-helper/main.swift): a hello line, then requests with an id
// and exactly one reply each, and driverExited as the only event. On Windows it also answers
// what only a process on the user's desktop can know: readiness (an interactive session, a
// usable input desktop, UI Automation) and one window's identity and admission facts.
//
// The helper runs exactly one embedded Cua Driver daemon from the files this build pinned, in
// a job object that ends with the helper. stdin EOF means the host is gone.
//
// Started with arguments ("mcp ..." or "revoke ..."), it is instead the agent's way to the
// driver: it runs the pinned driver with those arguments and relays its stdio (McpRelay.cs).

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Goat.ComputerUse
{
    internal static class Program
    {
        const int ProtocolVersion = 1;
        const int MaxLineBytes = 1 << 20;
        /// <summary>Names this helper process; replies and events are trusted only with it.</summary>
        public static readonly string Generation = Guid.NewGuid().ToString("N");
        static readonly object OutputLock = new object();
        static readonly Stream Output = Console.OpenStandardOutput();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxLineBytes };

        static void Emit(Dictionary<string, object> message)
        {
            byte[] line = new UTF8Encoding(false).GetBytes(Json.Serialize(message) + "\n");
            lock (OutputLock)
            {
                Output.Write(line, 0, line.Length);
                Output.Flush();
            }
        }

        static Dictionary<string, object> Message(string type)
        {
            var message = new Dictionary<string, object>();
            message["type"] = type;
            return message;
        }

        static int Main(string[] arguments)
        {
            string executable = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
            string refusal = WindowsFacts.ParentRefusal(BuildInfo.AllowAnyParent, executable, BuildInfo.ParentExecutable);
            if (arguments.Length > 0)
            {
                // Relay mode: stdout carries the driver's MCP lines, so problems go to stderr.
                if (refusal != null)
                {
                    Console.Error.WriteLine(refusal);
                    return 77;
                }
                try { return new DriverService(executable, delegate { }).Relay(arguments); }
                catch (HelperException error)
                {
                    Console.Error.WriteLine(error.Message);
                    return 78;
                }
            }
            if (refusal != null)
            {
                var refused = Message("refused");
                refused["reason"] = "untrusted_parent";
                refused["message"] = refusal;
                Emit(refused);
                return 77;
            }
            var service = new DriverService(executable, Emit);
            var signals = new Signals(Emit);
            var hello = Message("hello");
            hello["protocol"] = ProtocolVersion;
            hello["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            hello["bundleId"] = BuildInfo.HelperId;
            hello["version"] = BuildInfo.Version;
            hello["platform"] = "windows";
            hello["generation"] = Generation;
            hello["signals"] = Signals.Capabilities();
            Emit(hello);

            Stream input = Console.OpenStandardInput();
            var buffer = new MemoryStream();
            var chunk = new byte[64 * 1024];
            try
            {
                while (true)
                {
                    int read = input.Read(chunk, 0, chunk.Length);
                    if (read <= 0) break;
                    int start = 0;
                    for (int i = 0; i < read; i++)
                    {
                        if (chunk[i] != (byte)'\n') continue;
                        buffer.Write(chunk, start, i - start);
                        start = i + 1;
                        byte[] line = buffer.ToArray();
                        buffer.SetLength(0);
                        if (line.Length > 0) Handle(service, signals, new UTF8Encoding(false, true).GetString(line));
                    }
                    buffer.Write(chunk, start, read - start);
                    if (buffer.Length > MaxLineBytes)
                    {
                        var error = Message("error");
                        error["code"] = "line_too_long";
                        error["message"] = "Request line exceeds 1 MiB.";
                        Emit(error);
                        break;
                    }
                }
            }
            catch (IOException) { }
            finally
            {
                // The host is gone. Nothing more is written (a helper that exits clears every
                // target of its generation), and the driver stops even if listening does not.
                try { signals.Shutdown(); }
                finally { service.Stop(); }
            }
            return 0;
        }

        static void Handle(DriverService service, Signals signals, string line)
        {
            Dictionary<string, object> request = null;
            try { request = Json.DeserializeObject(line) as Dictionary<string, object>; }
            catch (ArgumentException) { }
            object id, method;
            if (request == null || !request.TryGetValue("id", out id) || !(id is string) ||
                !request.TryGetValue("method", out method) || !(method is string))
            {
                var error = Message("error");
                error["code"] = "bad_request";
                error["message"] = "Expected {id, method, params}.";
                Emit(error);
                return;
            }
            object raw;
            var parameters = request.TryGetValue("params", out raw) && raw is Dictionary<string, object>
                ? (Dictionary<string, object>)raw
                : new Dictionary<string, object>();
            var reply = new Dictionary<string, object>();
            reply["id"] = id;
            try
            {
                switch ((string)method)
                {
                    // The signals queue writes the answer in order: after the clears it owes the
                    // old watch, before the new watch's state.
                    case "watch":
                        reply["result"] = new Dictionary<string, object>();
                        object watchId;
                        if (!parameters.TryGetValue("watchId", out watchId) || !(watchId is string) || ((string)watchId).Trim().Length == 0)
                            throw new HelperException("bad_request", "watch needs a watchId.");
                        signals.Watch((string)watchId, Targets(parameters), reply);
                        return;
                    case "unwatch":
                        reply["result"] = new Dictionary<string, object>();
                        signals.Unwatch(reply);
                        return;
                    // Windows has no grant to prompt for; "prompt" is accepted and ignored.
                    case "permissions": reply["result"] = WindowsFacts.Readiness(); break;
                    case "start": reply["result"] = service.Start(parameters); break;
                    case "listApps": reply["result"] = service.ListApps(); break;
                    case "stop": service.Stop(); reply["result"] = new Dictionary<string, object>(); break;
                    case "window": reply["result"] = Window(parameters); break;
                    case "elementStates": reply["result"] = ElementStatesOf(parameters); break;
                    default: throw new HelperException("unknown_method", "Unknown method " + method + ".");
                }
            }
            catch (HelperException error)
            {
                reply["error"] = Failure(error.Code, error.Message);
            }
            catch (Exception error)
            {
                reply["error"] = Failure("internal", error.GetType().Name + ": " + error.Message);
            }
            Emit(reply);
        }

        static Dictionary<string, object> ElementStatesOf(Dictionary<string, object> parameters)
        {
            object pid, windowId;
            if (!parameters.TryGetValue("pid", out pid) || !(pid is int) ||
                !parameters.TryGetValue("windowId", out windowId) || !(windowId is int || windowId is long))
                throw new HelperException("bad_request", "elementStates needs an integer pid and windowId.");
            return ElementStates.Read((int)pid, Convert.ToInt64(windowId));
        }

        static Dictionary<string, object> Window(Dictionary<string, object> parameters)
        {
            object pid, windowId;
            if (!parameters.TryGetValue("pid", out pid) || !(pid is int) ||
                !parameters.TryGetValue("windowId", out windowId) || !(windowId is int || windowId is long))
                throw new HelperException("bad_request", "window needs an integer pid and windowId.");
            return WindowsFacts.Window((int)pid, Convert.ToInt64(windowId));
        }

        static Dictionary<string, object> Failure(string code, string message)
        {
            var failure = new Dictionary<string, object>();
            failure["code"] = code;
            failure["message"] = message;
            return failure;
        }

        /// <summary>watch's targets, at least one, each an exact window of a process.</summary>
        static List<Signals.Target> Targets(Dictionary<string, object> parameters)
        {
            object raw;
            if (!parameters.TryGetValue("targets", out raw) || !(raw is object[]) || ((object[])raw).Length == 0)
                throw new HelperException("bad_request", "watch needs targets: [{pid, windowId}, ...].");
            var targets = new List<Signals.Target>();
            var seen = new HashSet<string>();
            foreach (object entry in (object[])raw)
            {
                var target = entry as Dictionary<string, object>;
                object pid, windowId;
                if (target == null || !target.TryGetValue("pid", out pid) || !(pid is int) ||
                    !target.TryGetValue("windowId", out windowId) || !(windowId is int || windowId is long))
                    throw new HelperException("bad_request", "Each watch target needs an integer pid and windowId.");
                var next = new Signals.Target { Pid = (int)pid, WindowId = Convert.ToInt64(windowId) };
                if (seen.Add(next.Key)) targets.Add(next);
            }
            return targets;
        }
    }
}
