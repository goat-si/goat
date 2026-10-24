using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Goat.ComputerUse
{
    /// <summary>
    /// What only a process in the user's session can know: whether this session has a desktop
    /// to observe, whether input reaches it, and which window a target names. The desktop host
    /// turns these answers into onboarding states and typed refusals; nothing here prompts.
    /// </summary>
    internal static class WindowsFacts
    {
        // Mandatory label RIDs (winnt.h).
        public const int IntegrityMedium = 0x2000;

        public static uint SessionOf(int processId)
        {
            uint session;
            return NativeMethods.ProcessIdToSessionId((uint)processId, out session) ? session : uint.MaxValue;
        }

        /// <summary>
        /// "Default" on a usable desktop. The lock screen and UAC's secure desktop are "Winlogon"
        /// (or unreadable from a user process), and neither may be observed or driven.
        /// </summary>
        public static string InputDesktop()
        {
            IntPtr desktop = NativeMethods.OpenInputDesktop(0, false, NativeMethods.DESKTOP_READOBJECTS);
            if (desktop == IntPtr.Zero) return "unavailable";
            try
            {
                var name = new StringBuilder(256);
                int needed;
                return NativeMethods.GetUserObjectInformationW(desktop, NativeMethods.UOI_NAME, name, name.Capacity * 2, out needed)
                    ? name.ToString()
                    : "unavailable";
            }
            finally
            {
                NativeMethods.CloseDesktop(desktop);
            }
        }

        /// <summary>WTS_CONNECTSTATE_CLASS: a disconnected RDP or console session renders nothing.</summary>
        public static string ConnectState(uint session)
        {
            IntPtr buffer;
            int bytes;
            if (!NativeMethods.WTSQuerySessionInformationW(IntPtr.Zero, session, NativeMethods.WTSConnectState, out buffer, out bytes))
                return "unknown";
            try
            {
                int state = Marshal.ReadInt32(buffer);
                switch (state)
                {
                    case 0: return "active";
                    case 1: return "connected";
                    case 4: return "disconnected";
                    case 6: return "listen";
                    default: return "other";
                }
            }
            finally
            {
                NativeMethods.WTSFreeMemory(buffer);
            }
        }

        /// <summary>The mandatory integrity RID of a process, or -1 when its token is out of reach.</summary>
        public static int IntegrityOf(IntPtr process)
        {
            IntPtr token;
            if (!NativeMethods.OpenProcessToken(process, NativeMethods.TOKEN_QUERY, out token)) return -1;
            try
            {
                int length;
                NativeMethods.GetTokenInformation(token, NativeMethods.TokenIntegrityLevel, IntPtr.Zero, 0, out length);
                if (length <= 0) return -1;
                IntPtr info = Marshal.AllocHGlobal(length);
                try
                {
                    if (!NativeMethods.GetTokenInformation(token, NativeMethods.TokenIntegrityLevel, info, length, out length)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(info);
                    int count = Marshal.ReadByte(NativeMethods.GetSidSubAuthorityCount(sid));
                    return Marshal.ReadInt32(NativeMethods.GetSidSubAuthority(sid, (uint)(count - 1)));
                }
                finally
                {
                    Marshal.FreeHGlobal(info);
                }
            }
            finally
            {
                NativeMethods.CloseHandle(token);
            }
        }

        public static int OwnIntegrity()
        {
            return IntegrityOf(System.Diagnostics.Process.GetCurrentProcess().Handle);
        }

        /// <summary>
        /// The UI Automation root lists top-level windows only on a desktop this process can see.
        /// Session 0 and a secure desktop answer with no children.
        /// </summary>
        public static bool AutomationReachable()
        {
            return RunBounded(delegate
            {
                return AutomationElement.RootElement.FindFirst(TreeScope.Children, Condition.TrueCondition) != null;
            }, 3000, false);
        }

        /// <summary>Readiness in the shared onboarding terms; accessibility and screenRecording keep the macOS shape.</summary>
        public static Dictionary<string, object> Readiness()
        {
            uint session = SessionOf(System.Diagnostics.Process.GetCurrentProcess().Id);
            bool interactive = session != 0 && session != uint.MaxValue;
            string desktop = interactive ? InputDesktop() : "unavailable";
            string connect = interactive ? ConnectState(session) : "none";
            bool usable = interactive && desktop == "Default";
            bool automation = usable && AutomationReachable();
            int integrity = OwnIntegrity();
            var result = new Dictionary<string, object>();
            result["accessibility"] = automation;
            // The real capture check is the driver's non-blank frame in the desktop's verify step;
            // this says whether a frame could exist at all.
            result["screenRecording"] = usable && connect == "active";
            result["platform"] = "windows";
            result["sessionId"] = interactive ? (object)(long)session : null;
            result["consoleSessionId"] = (long)NativeMethods.WTSGetActiveConsoleSessionId();
            result["interactiveSession"] = interactive;
            result["connectState"] = connect;
            result["inputDesktop"] = desktop;
            result["uiAutomation"] = automation;
            result["helperElevated"] = integrity > IntegrityMedium;
            return result;
        }

        /// <summary>
        /// One window's identity and the facts that decide whether the helper may touch it. The
        /// epoch changes when the window, its virtual desktop, its monitor or its DPI changes.
        /// </summary>
        public static Dictionary<string, object> Window(int processId, long windowId)
        {
            var result = new Dictionary<string, object>();
            IntPtr window = new IntPtr(windowId);
            if (windowId == 0 || !NativeMethods.IsWindow(window))
            {
                result["exists"] = false;
                return result;
            }
            int owner;
            NativeMethods.GetWindowThreadProcessId(window, out owner);
            result["exists"] = true;
            result["ownerPid"] = owner;
            result["ownerMatches"] = owner == processId;
            if (owner != processId) return result;

            uint ownSession = SessionOf(System.Diagnostics.Process.GetCurrentProcess().Id);
            uint targetSession = SessionOf(processId);
            result["sameSession"] = ownSession == targetSession;

            Guid desktopId = Guid.Empty;
            bool onCurrentDesktop = true;
            try
            {
                var manager = (IVirtualDesktopManager)new VirtualDesktopManager();
                Guid found;
                if (manager.GetWindowDesktopId(window, out found) == 0) desktopId = found;
                bool current;
                if (manager.IsWindowOnCurrentVirtualDesktop(window, out current) == 0) onCurrentDesktop = current;
            }
            catch (COMException) { }
            catch (InvalidCastException) { }
            long monitor = NativeMethods.MonitorFromWindow(window, NativeMethods.MONITOR_DEFAULTTONEAREST).ToInt64();
            uint dpi = NativeMethods.GetDpiForWindow(window);
            result["epoch"] = "hwnd-" + windowId.ToString("x") + ":vd-" + desktopId.ToString("N") + ":mon-" + monitor.ToString("x") + ":dpi-" + dpi;
            result["onCurrentDesktop"] = onCurrentDesktop;
            result["minimized"] = NativeMethods.IsIconic(window);
            var title = new StringBuilder(512);
            NativeMethods.GetWindowTextW(window, title, title.Capacity);
            result["title"] = title.ToString();

            // UIPI drops input from a lower integrity level, and a non-elevated helper must never
            // reach an elevated window; a token we cannot read counts as higher.
            int targetIntegrity = -1;
            IntPtr process = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
            if (process != IntPtr.Zero)
            {
                targetIntegrity = IntegrityOf(process);
                NativeMethods.CloseHandle(process);
            }
            int own = OwnIntegrity();
            result["targetIntegrity"] = targetIntegrity;
            result["helperIntegrity"] = own;
            result["elevatedTarget"] = targetIntegrity < 0 || targetIntegrity > own;

            string desktopName = InputDesktop();
            result["inputDesktop"] = desktopName;
            result["focus"] = desktopName == "Default" ? FocusedSecure(processId) : "unknown";
            return result;
        }

        /// <summary>
        /// Which process has keyboard focus and whether it is a password field, read now. False
        /// when UI Automation did not answer in time; callers treat that as private.
        /// </summary>
        public static bool Focus(out int processId, out bool password)
        {
            int pid = 0;
            bool secure = false;
            bool done = RunBounded(delegate
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                if (focused == null) return true;
                pid = focused.Current.ProcessId;
                secure = focused.Current.IsPassword;
                return true;
            }, 2000, false);
            processId = pid;
            password = secure;
            return done;
        }

        /// <summary>
        /// "secure" when keyboard focus is on a password field of this process (D6), "clear" when
        /// it is not, "unknown" when UI Automation did not answer in time; callers treat unknown
        /// as private.
        /// </summary>
        public static string FocusedSecure(int processId)
        {
            string answer = "unknown";
            bool done = RunBounded(delegate
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                if (focused == null) { answer = "clear"; return true; }
                answer = focused.Current.ProcessId == processId && focused.Current.IsPassword ? "secure" : "clear";
                return true;
            }, 2000, false);
            return done ? answer : "unknown";
        }

        /// <summary>UI Automation calls into the target process and can hang with it.</summary>
        static bool RunBounded(Func<bool> work, int milliseconds, bool fallback)
        {
            bool result = fallback;
            Exception failure = null;
            var thread = new Thread(delegate ()
            {
                try { result = work(); }
                catch (Exception error) { failure = error; }
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            if (!thread.Join(milliseconds)) return fallback;
            return failure == null ? result : fallback;
        }

        /// <summary>
        /// Release helpers serve only the GOAT executable installed beside them and signed by the
        /// same publisher. Electron's ELECTRON_RUN_AS_NODE still lets that executable run other
        /// code; release builds ship the helper only once #1210 closes that.
        /// </summary>
        public static string ParentRefusal(bool allowAnyParent, string helperPath, string expectedParentName)
        {
            if (allowAnyParent) return null;
            var self = System.Diagnostics.Process.GetCurrentProcess();
            var info = new NativeMethods.PROCESS_BASIC_INFORMATION();
            int returned;
            if (NativeMethods.NtQueryInformationProcess(self.Handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0)
                return "The helper cannot read which process started it.";
            int parentId = info.InheritedFromUniqueProcessId.ToInt32();
            IntPtr parent = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, parentId);
            if (parent == IntPtr.Zero) return "The process that started the helper is gone.";
            try
            {
                long parentCreated, ownCreated, unused1, unused2, unused3;
                NativeMethods.GetProcessTimes(parent, out parentCreated, out unused1, out unused2, out unused3);
                NativeMethods.GetProcessTimes(self.Handle, out ownCreated, out unused1, out unused2, out unused3);
                // A recycled pid belongs to a process younger than the helper.
                if (parentCreated > ownCreated) return "The process that started the helper is gone.";
                var name = new StringBuilder(1024);
                int size = name.Capacity;
                if (!NativeMethods.QueryFullProcessImageNameW(parent, 0, name, ref size))
                    return "The helper cannot read its parent's executable.";
                string parentPath = name.ToString();
                // <install>\GOAT.exe starts <install>\resources\computer-use-helper\GOAT Computer Use.exe.
                string install = System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(helperPath), "..", ".."));
                string expected = System.IO.Path.Combine(install, expectedParentName);
                if (!string.Equals(System.IO.Path.GetFullPath(parentPath), expected, StringComparison.OrdinalIgnoreCase))
                    return "The helper was not started by " + expected + ".";
                string ownSigner = Signer(helperPath);
                string parentSigner = Signer(parentPath);
                if (ownSigner == null) return "This helper is not signed, so it cannot verify who started it.";
                if (parentSigner != ownSigner) return "The process that started the helper is not signed by the same publisher.";
                if (!Authenticode.Verify(helperPath) || !Authenticode.Verify(parentPath))
                    return "The helper or the process that started it fails Authenticode verification.";
                return null;
            }
            finally
            {
                NativeMethods.CloseHandle(parent);
            }
        }

        static string Signer(string path)
        {
            try { return new X509Certificate2(X509Certificate.CreateFromSignedFile(path)).Thumbprint; }
            catch (System.Security.Cryptography.CryptographicException) { return null; }
        }
    }
}
