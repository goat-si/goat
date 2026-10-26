// Live pictures of single windows for GOAT's desktop computer use sessions (#1370), the Windows
// counterpart of the macOS helper's Frames.swift and the same frames request.
//
// The host names the windows to capture; the server decides those (apps/server/src/preview/
// DesktopFrames.ts) and checks every frame again, so this only refuses what it can see itself:
// a window that is gone or not top-level, GOAT's own windows, an app the control did not
// approve, an elevated window, a locked or secure desktop, or a password field focused in the
// window's process. Each capture is the window alone through PrintWindow (CaptureGuard), never a
// copy of the screen (#1329), so nothing covering it can appear.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Goat.ComputerUse
{
    internal sealed class FrameSource
    {
        // The protocol's limits (PREVIEW_SESSION_FRAME_LIMITS in packages/contracts previewSession.ts).
        const int MaxWidth = 480;
        const int MinIntervalMs = 500;
        /// <summary>256 KiB, less the 2 bytes base64 padding can add to the server's estimate.</summary>
        const int MaxBytes = 256 * 1024 - 2;
        static readonly long[] Qualities = { 60, 35 };
        const uint GA_ROOT = 2;
        const int MaxKnownApps = 64;

        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

        sealed class Target
        {
            public string Key;
            /// <summary>Kept wide: a pid past int's range matches no process and is windowGone.</summary>
            public long Pid;
            public long WindowId;
            /// <summary>Lowercase app ids the control approved; null allows every app the driver admits.</summary>
            public HashSet<string> Apps;
            public int MaxWidth;
            public int IntervalMs;
            public DateTime Due;
            /// <summary>The reason last told for this target; a frame clears it.</summary>
            public string Told;
        }

        readonly DriverService service;
        readonly Action<Dictionary<string, object>> emit;
        readonly int ownPid = System.Diagnostics.Process.GetCurrentProcess().Id;
        readonly int hostPid;
        readonly string hostImage;
        /// <summary>The ids the driver lists for a process, by pid and start time, lowercase.</summary>
        readonly Dictionary<string, HashSet<string>> knownApps = new Dictionary<string, HashSet<string>>();
        readonly object gate = new object();
        long framesId = -1;
        List<Target> targets = new List<Target>();
        bool ended;

        /// <summary>
        /// emit only queues (HelperOutput) and never waits on stdout, so it is called under gate:
        /// a replaced request's frames are always queued before its replacement's answer.
        /// </summary>
        public FrameSource(DriverService service, Action<Dictionary<string, object>> emit)
        {
            this.service = service;
            this.emit = emit;
            hostPid = ParentPid();
            hostImage = hostPid == 0 ? null : ImageOf(hostPid);
            // One capture at a time, off the request loop: UI Automation and the driver's app list
            // can take seconds, and other requests must not wait for them.
            var worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Start();
        }

        /// <summary>
        /// Replaces the windows captured and queues the answer (reply) behind every frame of the
        /// old request, so none of those is written after it.
        /// </summary>
        public void Frames(Dictionary<string, object> parameters, Dictionary<string, object> reply)
        {
            object rawId, rawTargets;
            if (!parameters.TryGetValue("framesId", out rawId) || !(rawId is int || rawId is long) ||
                !parameters.TryGetValue("targets", out rawTargets) || !(rawTargets is object[]))
                throw new HelperException("bad_request", "frames needs a framesId and targets.");
            var next = new List<Target>();
            foreach (object raw in (object[])rawTargets)
                next.Add(Parse(raw as Dictionary<string, object>) ?? Bad());
            var answer = new Dictionary<string, object>();
            answer["framesId"] = rawId;
            reply["result"] = answer;
            lock (gate)
            {
                framesId = Convert.ToInt64(rawId);
                targets = next;
                Monitor.PulseAll(gate);
                emit(reply);
            }
        }

        /// <summary>Stops every capture for good; nothing more is queued.</summary>
        public void Shutdown()
        {
            lock (gate)
            {
                ended = true;
                targets = new List<Target>();
                Monitor.PulseAll(gate);
            }
        }

        static Target Bad() { throw new HelperException("bad_request", "A frames target is malformed."); }

        static Target Parse(Dictionary<string, object> entry)
        {
            object key, pid, windowId, maxWidth, intervalMs, apps;
            if (entry == null ||
                !entry.TryGetValue("key", out key) || !(key is string) || ((string)key).Length == 0 ||
                !entry.TryGetValue("pid", out pid) || !(pid is int || pid is long) || Convert.ToInt64(pid) <= 0 ||
                // Window 0 is valid on the wire and simply matches no window: windowGone.
                !entry.TryGetValue("windowId", out windowId) || !(windowId is int || windowId is long) || Convert.ToInt64(windowId) < 0 ||
                !entry.TryGetValue("maxWidth", out maxWidth) || !(maxWidth is int) || (int)maxWidth <= 0 ||
                !entry.TryGetValue("intervalMs", out intervalMs) || !(intervalMs is int) || (int)intervalMs <= 0)
                return null;
            HashSet<string> approved = null;
            if (entry.TryGetValue("apps", out apps) && apps != null)
            {
                if (!(apps is object[]) || ((object[])apps).Any(app => !(app is string))) return null;
                approved = new HashSet<string>(((object[])apps).Select(app => ((string)app).ToLowerInvariant()));
            }
            return new Target
            {
                Key = (string)key,
                Pid = Convert.ToInt64(pid),
                WindowId = Convert.ToInt64(windowId),
                Apps = approved,
                MaxWidth = Math.Min((int)maxWidth, MaxWidth),
                IntervalMs = Math.Max((int)intervalMs, MinIntervalMs),
                Due = DateTime.MinValue,
            };
        }

        void Run()
        {
            while (true)
            {
                Target target;
                long forId;
                lock (gate)
                {
                    while (true)
                    {
                        if (ended) return;
                        DateTime now = DateTime.UtcNow;
                        target = targets.OrderBy(candidate => candidate.Due).FirstOrDefault();
                        if (target != null && target.Due <= now) break;
                        if (target == null) Monitor.Wait(gate);
                        else Monitor.Wait(gate, target.Due - now);
                    }
                    forId = framesId;
                }
                Dictionary<string, object> answer;
                try { answer = Capture(target); }
                catch (Exception) { answer = Unavailable("captureFailed"); }
                lock (gate)
                {
                    // From the end of this capture, so a slow one (the first app check lists the
                    // driver's apps) never lets the next follow at once: at most one per interval.
                    target.Due = DateTime.UtcNow.AddMilliseconds(target.IntervalMs);
                    // A replaced request's capture says nothing.
                    if (ended || forId != framesId || !targets.Contains(target)) continue;
                    object reason;
                    if (answer.TryGetValue("unavailable", out reason))
                    {
                        if (target.Told == (string)reason) continue;
                        target.Told = (string)reason;
                        answer.Remove("unavailable");
                        answer["type"] = "frameUnavailable";
                        answer["reason"] = reason;
                    }
                    else
                    {
                        target.Told = null;
                        answer["type"] = "frame";
                    }
                    answer["framesId"] = forId;
                    answer["key"] = target.Key;
                    emit(answer);
                }
            }
        }

        /// <summary>One JPEG of the target window, or {unavailable: reason}.</summary>
        Dictionary<string, object> Capture(Target target)
        {
            if (target.Pid > int.MaxValue) return Unavailable("windowGone");
            int pid = (int)target.Pid;
            IntPtr window = new IntPtr(target.WindowId);
            Dictionary<string, object> facts = WindowsFacts.Window(pid, target.WindowId);
            if (!(bool)facts["exists"] || !(bool)facts["ownerMatches"]) return Unavailable("windowGone");
            if (GetAncestor(window, GA_ROOT) != window) return Unavailable("windowUnknown");
            // The process as it is now, so a window handle reused by another process, or a pid
            // reused by another program, during the checks below is caught.
            long started = StartTime(pid);
            if (started == 0) return Unavailable("unsupported");
            if (IsGoat(pid)) return Unavailable("appNotApproved");
            if (target.Apps != null && !Approved(pid, target.Apps)) return Unavailable("appNotApproved");
            if (!(bool)facts["sameSession"] || (bool)facts["elevatedTarget"] ||
                (facts.ContainsKey("protectedSurface") && (bool)facts["protectedSurface"]) ||
                WindowsFacts.IsProtectedWindow(window, pid))
                return Unavailable("unsupported");
            // The lock screen or a UAC prompt holds the input desktop: nothing of it is shown.
            if ((string)facts["inputDesktop"] != "Default") return Unavailable("paused");
            // Unknown counts as private: no answer from UI Automation is no proof of a clear field.
            if ((string)facts["focus"] != "clear") return Unavailable("private");

            // App approval can take seconds: read ownership, the desktop and focus again right
            // before the capture, and once more after it, so a reused window, a lock screen, a
            // UAC prompt or a secret field that arrived meanwhile drops the picture.
            string blocked = Admission(window, pid, started);
            if (blocked != null) return Unavailable(blocked);
            byte[] jpeg;
            int width, height;
            using (Bitmap native = CaptureGuard.CaptureNative(window))
            {
                if (native == null) return Unavailable("captureFailed");
                width = Math.Min(target.MaxWidth, native.Width);
                height = Math.Max(1, (int)Math.Round(native.Height * (double)width / native.Width));
                jpeg = Jpeg(native, width, height);
            }
            if (jpeg == null) return Unavailable("captureFailed");
            blocked = Admission(window, pid, started);
            if (blocked != null) return Unavailable(blocked);
            var frame = new Dictionary<string, object>();
            frame["width"] = width;
            frame["height"] = height;
            frame["data"] = Convert.ToBase64String(jpeg);
            return frame;
        }

        static Dictionary<string, object> Unavailable(string reason)
        {
            var answer = new Dictionary<string, object>();
            answer["unavailable"] = reason;
            return answer;
        }

        /// <summary>
        /// Why the window may not be pictured now, read fresh: windowGone when the window no
        /// longer belongs to that same process, paused when another desktop has input (or it
        /// cannot be read), private when a password field of the process has focus or focus
        /// cannot be read. The focus read can take seconds, so the desktop and ownership are
        /// read again after it.
        /// </summary>
        static string Admission(IntPtr window, int pid, long started)
        {
            if (!Owned(window, pid, started)) return "windowGone";
            if (WindowsFacts.IsProtectedWindow(window, pid)) return "unsupported";
            if (WindowsFacts.InputDesktop() != "Default") return "paused";
            if (WindowsFacts.FocusedSecure(pid) != "clear") return "private";
            if (WindowsFacts.InputDesktop() != "Default") return "paused";
            if (WindowsFacts.IsProtectedWindow(window, pid)) return "unsupported";
            return Owned(window, pid, started) ? null : "windowGone";
        }

        static bool Owned(IntPtr window, int pid, long started)
        {
            int owner;
            return NativeMethods.IsWindow(window) && NativeMethods.GetWindowThreadProcessId(window, out owner) != 0 &&
                owner == pid && StartTime(pid) == started;
        }

        /// <summary>The window scaled to width x height, lowering quality once before giving up.</summary>
        static byte[] Jpeg(Bitmap source, int width, int height)
        {
            ImageCodecInfo codec = ImageCodecInfo.GetImageEncoders().First(info => info.FormatID == ImageFormat.Jpeg.Guid);
            using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(scaled))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height));
                }
                foreach (long quality in Qualities)
                {
                    using (var parameters = new EncoderParameters(1))
                    using (var output = new MemoryStream())
                    {
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                        scaled.Save(output, codec, parameters);
                        if (output.Length <= MaxBytes) return output.ToArray();
                    }
                }
            }
            return null;
        }

        /// <summary>
        /// GOAT's own windows (this helper, the desktop app that started it, and any window of
        /// that same executable) never become a tile's picture: the tile would show itself.
        /// </summary>
        bool IsGoat(int pid)
        {
            if (pid == ownPid || pid == hostPid) return true;
            if (hostImage == null) return false;
            string image = ImageOf(pid);
            return image != null && string.Equals(image, hostImage, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Whether the process is an app the control approved, judged as the server judges an
        /// agent's call: the driver's own list_apps id or name for that pid.
        /// </summary>
        bool Approved(int pid, HashSet<string> apps)
        {
            string key = pid + ":" + StartTime(pid);
            HashSet<string> ids;
            if (!knownApps.TryGetValue(key, out ids))
            {
                ids = new HashSet<string>();
                var listed = service.ListApps() as Dictionary<string, object>;
                object entries;
                if (listed != null && listed.TryGetValue("apps", out entries) && entries is object[])
                {
                    foreach (object raw in (object[])entries)
                    {
                        var app = raw as Dictionary<string, object>;
                        object appPid;
                        if (app == null || !app.TryGetValue("pid", out appPid) || !(appPid is int) || (int)appPid != pid) continue;
                        foreach (string field in new[] { "bundle_id", "name", "executable" })
                        {
                            object value;
                            if (app.TryGetValue(field, out value) && value is string && ((string)value).Trim().Length > 0)
                                ids.Add(((string)value).ToLowerInvariant());
                        }
                    }
                }
                if (knownApps.Count >= MaxKnownApps) knownApps.Clear();
                knownApps[key] = ids;
            }
            return ids.Overlaps(apps);
        }

        static long StartTime(int pid)
        {
            IntPtr process = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return 0;
            try
            {
                long created, unused1, unused2, unused3;
                return NativeMethods.GetProcessTimes(process, out created, out unused1, out unused2, out unused3) ? created : 0;
            }
            finally { NativeMethods.CloseHandle(process); }
        }

        static string ImageOf(int pid)
        {
            IntPtr process = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                var name = new StringBuilder(1024);
                int size = name.Capacity;
                return NativeMethods.QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : null;
            }
            finally { NativeMethods.CloseHandle(process); }
        }

        static int ParentPid()
        {
            var info = new NativeMethods.PROCESS_BASIC_INFORMATION();
            int returned;
            IntPtr self = System.Diagnostics.Process.GetCurrentProcess().Handle;
            return NativeMethods.NtQueryInformationProcess(self, 0, ref info, Marshal.SizeOf(info), out returned) == 0
                ? info.InheritedFromUniqueProcessId.ToInt32()
                : 0;
        }
    }
}
