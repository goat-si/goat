using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

namespace Goat.ComputerUse
{
    /// <summary>
    /// The safety signals an agent session needs (#1235), only while the host watches (D7):
    /// keyboard focus entering or leaving a password field of a watched window's process, and a
    /// person using the keyboard or mouse. Input that software injected, such as the driver's
    /// own SendInput, is not a person and is skipped. Events carry no content: not the keys, not
    /// the pointer position, not what the field holds.
    ///
    /// Ordering follows ComputerUseWatchRequest: a target that leaves while private is cleared
    /// under the old watch id before the request is answered, and a new watch reports every
    /// target's state after its answer, so no clearing event can be dropped.
    /// </summary>
    internal sealed class Signals
    {
        const int WH_KEYBOARD_LL = 13;
        const int WH_MOUSE_LL = 14;
        const uint LLKHF_INJECTED = 0x10;
        const uint LLMHF_INJECTED = 0x01;
        const uint WM_QUIT = 0x0012;
        /// <summary>One humanInput event per source per interval is enough to stop an agent.</summary>
        const int HumanInputIntervalMs = 500;

        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll")]
        static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")]
        static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr GetModuleHandle(string name);

        readonly object gate = new object();
        readonly Action<Dictionary<string, object>> emit;
        readonly BlockingCollection<Dictionary<string, object>> outbox = new BlockingCollection<Dictionary<string, object>>();
        string watchId;
        Dictionary<int, long> targets = new Dictionary<int, long>();
        readonly Dictionary<int, bool> privateByPid = new Dictionary<int, bool>();
        AutomationFocusChangedEventHandler focusHandler;
        Thread hookThread;
        uint hookThreadId;
        HookProc keyboardProc, mouseProc;
        long lastKeyboard, lastPointer;

        public Signals(Action<Dictionary<string, object>> emit)
        {
            this.emit = emit;
            // Hooks must return at once; their events leave through this queue on its own thread.
            var sender = new Thread(delegate () { foreach (var message in outbox.GetConsumingEnumerable()) emit(message); });
            sender.IsBackground = true;
            sender.Start();
        }

        public static Dictionary<string, object> Capabilities()
        {
            var signals = new Dictionary<string, object>();
            signals["privateMode"] = "supported";
            signals["humanInput"] = "supported";
            return signals;
        }

        /// <summary>
        /// Replaces the watch. Targets leaving while private are cleared under the old id, then
        /// the request is answered, then every target's state goes out under the new id.
        /// </summary>
        public void Watch(string nextWatchId, Dictionary<int, long> nextTargets, Action answer)
        {
            lock (gate)
            {
                foreach (KeyValuePair<int, long> target in targets)
                    if (!nextTargets.ContainsKey(target.Key)) ClearLocked(target.Key, target.Value);
                watchId = nextWatchId;
                targets = nextTargets;
                privateByPid.Clear();
                if (focusHandler == null)
                {
                    focusHandler = OnFocusChanged;
                    Automation.AddAutomationFocusChangedEventHandler(focusHandler);
                }
                if (hookThread == null) StartHooks();
                answer();
            }
            foreach (KeyValuePair<int, long> target in nextTargets)
                Report(nextWatchId, target.Key, WindowsFacts.FocusedSecure(target.Key) != "clear");
        }

        /// <summary>Clears every private target, answers, then stops listening.</summary>
        public void Unwatch(Action answer)
        {
            AutomationFocusChangedEventHandler handler;
            uint threadId;
            Thread thread;
            lock (gate)
            {
                foreach (KeyValuePair<int, long> target in targets) ClearLocked(target.Key, target.Value);
                watchId = null;
                targets = new Dictionary<int, long>();
                privateByPid.Clear();
                handler = focusHandler;
                focusHandler = null;
                threadId = hookThreadId;
                thread = hookThread;
                hookThread = null;
                hookThreadId = 0;
                answer();
            }
            if (handler != null) Automation.RemoveAutomationFocusChangedEventHandler(handler);
            if (thread != null)
            {
                PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                thread.Join(2000);
            }
        }

        /// <summary>A private target that leaves the watch gets active:false, written before anything else.</summary>
        void ClearLocked(int pid, long windowId)
        {
            bool active;
            if (watchId == null || !privateByPid.TryGetValue(pid, out active) || !active) return;
            privateByPid[pid] = false;
            emit(Frame(watchId, PrivateMode(pid, windowId, false)));
        }

        void OnFocusChanged(object sender, AutomationFocusChangedEventArgs args)
        {
            int pid;
            bool password;
            try
            {
                var element = sender as AutomationElement;
                if (element == null) return;
                pid = element.Current.ProcessId;
                password = element.Current.IsPassword;
            }
            catch (ElementNotAvailableException) { return; }
            catch (InvalidOperationException) { return; }
            string current;
            List<int> watched;
            lock (gate)
            {
                current = watchId;
                watched = new List<int>(targets.Keys);
            }
            // Focus moving anywhere, including a closing window handing it on, ends private
            // mode in every other watched process.
            foreach (int target in watched) Report(current, target, target == pid && password, true);
        }

        /// <summary>
        /// Sends a target's state under watchId. A first report after watch always goes out;
        /// later ones only when the state changes. Nothing goes out for a watch that ended.
        /// </summary>
        void Report(string forWatch, int pid, bool active, bool onlyChanges = false)
        {
            lock (gate)
            {
                long windowId;
                if (forWatch == null || forWatch != watchId || !targets.TryGetValue(pid, out windowId)) return;
                bool previous;
                bool known = privateByPid.TryGetValue(pid, out previous);
                if (onlyChanges && known && previous == active) return;
                if (!onlyChanges && known) return;
                privateByPid[pid] = active;
                outbox.Add(Frame(watchId, PrivateMode(pid, windowId, active)));
            }
        }

        static Dictionary<string, object> PrivateMode(int pid, long windowId, bool active)
        {
            var target = new Dictionary<string, object>();
            target["pid"] = pid;
            target["windowId"] = windowId;
            var signal = new Dictionary<string, object>();
            signal["type"] = "privateMode";
            signal["active"] = active;
            signal["target"] = target;
            return signal;
        }

        static Dictionary<string, object> Frame(string forWatch, Dictionary<string, object> signal)
        {
            var frame = new Dictionary<string, object>();
            frame["generation"] = Program.Generation;
            frame["watchId"] = forWatch;
            frame["event"] = signal;
            return frame;
        }

        void StartHooks()
        {
            var ready = new ManualResetEvent(false);
            hookThread = new Thread(delegate ()
            {
                hookThreadId = GetCurrentThreadId();
                keyboardProc = OnKeyboard;
                mouseProc = OnMouse;
                IntPtr module = GetModuleHandle(null);
                IntPtr keyboard = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
                IntPtr mouse = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
                ready.Set();
                MSG message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
                if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
                if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
            });
            hookThread.IsBackground = true;
            hookThread.Start();
            ready.WaitOne(2000);
        }

        IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (((KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT))).flags & LLKHF_INJECTED) == 0)
                Human("keyboard", ref lastKeyboard);
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (((MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT))).flags & LLMHF_INJECTED) == 0)
                Human("pointer", ref lastPointer);
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        void Human(string source, ref long last)
        {
            long now = Environment.TickCount;
            if (now - Interlocked.Read(ref last) < HumanInputIntervalMs) return;
            Interlocked.Exchange(ref last, now);
            string current;
            lock (gate) current = watchId;
            if (current == null) return;
            var signal = new Dictionary<string, object>();
            signal["type"] = "humanInput";
            signal["source"] = source;
            outbox.Add(Frame(current, signal));
        }
    }
}