using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

namespace Goat.ComputerUse
{
    /// <summary>
    /// The safety signals an agent session needs (#1235), only while the host watches (D7):
    /// keyboard focus on a password field in a watched window's process, and a person using the
    /// keyboard or mouse. Input that software injected, such as the driver's own SendInput, is
    /// not a person and is skipped. Events carry no content: no keys, no pointer position, nothing
    /// a field holds.
    ///
    /// One thread owns all watch state and one queue carries everything it writes, so the order
    /// ComputerUseWatchRequest requires holds: a target that leaves while private is cleared under
    /// the old watch id, then the request is answered, then every target's state goes out under
    /// the new id. Focus events carry no sample; the owner reads focus itself, after any switch,
    /// so an old sample can never speak for a new watch. Hook callbacks only enqueue.
    /// </summary>
    internal sealed class Signals
    {
        const int WH_KEYBOARD_LL = 13;
        const int WH_MOUSE_LL = 14;
        const uint LLKHF_INJECTED = 0x10;
        const uint LLMHF_INJECTED = 0x01;
        const uint WM_QUIT = 0x0012;
        /// <summary>One humanInput event per source per interval is enough to stop an agent.</summary>
        static readonly long HumanInputInterval = Stopwatch.Frequency / 2;

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

        /// <summary>One watched window; a target is the pair, not the process.</summary>
        internal struct Target
        {
            public int Pid;
            public long WindowId;
            public string Key { get { return Pid + ":" + WindowId; } }
        }

        readonly BlockingCollection<Action> inbox = new BlockingCollection<Action>();
        readonly BlockingCollection<Dictionary<string, object>> outbox = new BlockingCollection<Dictionary<string, object>>();
        readonly Thread owner;

        // Owned by the owner thread.
        string watchId;
        List<Target> targets = new List<Target>();
        readonly Dictionary<string, bool> active = new Dictionary<string, bool>();
        AutomationFocusChangedEventHandler focusHandler;
        Thread hookThread;
        uint hookThreadId;
        HookProc keyboardProc, mouseProc;

        // Read by hook callbacks without locks.
        volatile string inputWatch;
        int focusPending;
        long lastKeyboard, lastPointer;
        int sawKeyboard, sawPointer;

        public Signals(Action<Dictionary<string, object>> emit)
        {
            var writer = new Thread(delegate () { foreach (var frame in outbox.GetConsumingEnumerable()) emit(frame); });
            writer.IsBackground = true;
            writer.Start();
            owner = new Thread(delegate () { foreach (Action work in inbox.GetConsumingEnumerable()) work(); });
            owner.IsBackground = true;
            owner.Start();
        }

        public static Dictionary<string, object> Capabilities()
        {
            var signals = new Dictionary<string, object>();
            signals["privateMode"] = "supported";
            signals["humanInput"] = "supported";
            return signals;
        }

        /// <summary>Queues a watch; its answer (reply) is written in order with its events.</summary>
        public void Watch(string nextWatchId, List<Target> nextTargets, Dictionary<string, object> reply)
        {
            inbox.Add(delegate { DoWatch(nextWatchId, nextTargets, reply); });
        }

        public void Unwatch(Dictionary<string, object> reply)
        {
            inbox.Add(delegate { DoUnwatch(reply); });
        }

        /// <summary>
        /// The host is gone: stop listening without writing anything, since nobody reads stdout
        /// now and a helper that exits clears every target of its generation.
        /// </summary>
        public void Shutdown()
        {
            try
            {
                inbox.Add(delegate { StopListening(); });
                inbox.CompleteAdding();
            }
            catch (InvalidOperationException) { }
            owner.Join(3000);
        }

        void DoWatch(string nextWatchId, List<Target> nextTargets, Dictionary<string, object> reply)
        {
            string failure = StartListening();
            if (failure != null)
            {
                // The old watch stays as it was.
                reply.Remove("result");
                reply["error"] = Error("signals_unavailable", failure);
                outbox.Add(reply);
                return;
            }
            var next = new HashSet<string>();
            foreach (Target target in nextTargets) next.Add(target.Key);
            foreach (Target target in targets)
                if (!next.Contains(target.Key)) Clear(target);
            watchId = nextWatchId;
            targets = nextTargets;
            active.Clear();
            inputWatch = nextWatchId;
            outbox.Add(reply);
            Reconcile(true);
        }

        void DoUnwatch(Dictionary<string, object> reply)
        {
            foreach (Target target in targets) Clear(target);
            watchId = null;
            inputWatch = null;
            targets = new List<Target>();
            active.Clear();
            outbox.Add(reply);
            StopListening();
        }

        /// <summary>A private target that leaves the watch gets active:false under the watch it leaves.</summary>
        void Clear(Target target)
        {
            bool was;
            if (watchId != null && active.TryGetValue(target.Key, out was) && was)
                outbox.Add(Frame(watchId, PrivateMode(target, false)));
            active[target.Key] = false;
        }

        /// <summary>
        /// Reads focus now and reports each target whose state changed; every target when the
        /// watch has just started. Focus UI Automation cannot read counts as private.
        /// </summary>
        void Reconcile(bool all)
        {
            if (watchId == null) return;
            int pid;
            bool password;
            bool known = WindowsFacts.Focus(out pid, out password);
            foreach (Target target in targets)
            {
                bool now = !known || (password && pid == target.Pid);
                bool was;
                if (!all && active.TryGetValue(target.Key, out was) && was == now) continue;
                active[target.Key] = now;
                outbox.Add(Frame(watchId, PrivateMode(target, now)));
            }
        }

        void OnFocusChanged(object sender, AutomationFocusChangedEventArgs args)
        {
            // Coalesced: one pending reconcile reads the latest focus for any number of events.
            if (Interlocked.Exchange(ref focusPending, 1) == 1) return;
            try
            {
                inbox.Add(delegate
                {
                    Interlocked.Exchange(ref focusPending, 0);
                    Reconcile(false);
                });
            }
            catch (InvalidOperationException) { }
        }

        string StartListening()
        {
            if (hookThread == null)
            {
                string failure = StartHooks();
                if (failure != null) return failure;
            }
            if (focusHandler == null)
            {
                focusHandler = OnFocusChanged;
                Automation.AddAutomationFocusChangedEventHandler(focusHandler);
            }
            return null;
        }

        void StopListening()
        {
            if (focusHandler != null)
            {
                Automation.RemoveAutomationFocusChangedEventHandler(focusHandler);
                focusHandler = null;
            }
            if (hookThread != null)
            {
                PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                hookThread.Join(2000);
                hookThread = null;
                hookThreadId = 0;
            }
        }

        /// <summary>Installs both hooks on a thread that pumps their messages, or neither.</summary>
        string StartHooks()
        {
            var ready = new ManualResetEvent(false);
            string failure = null;
            uint threadId = 0;
            keyboardProc = OnKeyboard;
            mouseProc = OnMouse;
            var thread = new Thread(delegate ()
            {
                threadId = GetCurrentThreadId();
                IntPtr module = GetModuleHandle(null);
                IntPtr keyboard = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
                IntPtr mouse = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
                if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero)
                {
                    failure = "Windows refused the input hooks (" + Marshal.GetLastWin32Error() + "), so a person's input could not be noticed.";
                    if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
                    if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
                    ready.Set();
                    return;
                }
                ready.Set();
                MSG message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
                UnhookWindowsHookEx(keyboard);
                UnhookWindowsHookEx(mouse);
            });
            thread.IsBackground = true;
            thread.Start();
            if (!ready.WaitOne(2000))
            {
                if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                return "The input hooks did not start in time.";
            }
            if (failure != null) return failure;
            hookThread = thread;
            hookThreadId = threadId;
            return null;
        }

        IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (((KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT))).flags & LLKHF_INJECTED) == 0)
                Human("keyboard", ref lastKeyboard, ref sawKeyboard);
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (((MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT))).flags & LLMHF_INJECTED) == 0)
                Human("pointer", ref lastPointer, ref sawPointer);
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        /// <summary>Runs inside the hook: no locks, no I/O, only a non-blocking enqueue.</summary>
        void Human(string source, ref long last, ref int seen)
        {
            string current = inputWatch;
            if (current == null) return;
            long now = Stopwatch.GetTimestamp();
            if (Interlocked.Exchange(ref seen, 1) == 1 && now - Interlocked.Read(ref last) < HumanInputInterval) return;
            Interlocked.Exchange(ref last, now);
            var signal = new Dictionary<string, object>();
            signal["type"] = "humanInput";
            signal["source"] = source;
            outbox.TryAdd(Frame(current, signal));
        }

        static Dictionary<string, object> PrivateMode(Target target, bool on)
        {
            var where = new Dictionary<string, object>();
            where["pid"] = target.Pid;
            where["windowId"] = target.WindowId;
            var signal = new Dictionary<string, object>();
            signal["type"] = "privateMode";
            signal["active"] = on;
            signal["target"] = where;
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

        static Dictionary<string, object> Error(string code, string message)
        {
            var error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message;
            return error;
        }
    }
}