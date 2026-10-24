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
    /// One thread owns all watch state and one queue (SignalOutbox) carries everything written,
    /// so the order ComputerUseWatchRequest requires holds: a target that leaves while private is
    /// cleared under the old watch id, then the request is answered, then every target's state
    /// goes out under the new id. A short lock around only those enqueues, which hooks take too,
    /// puts every humanInput either before the answer under the old id or after it under the new
    /// one. Focus events carry no sample; the owner reads focus and window liveness itself, after
    /// any switch, so an old sample can never speak for a new watch.
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
        [DllImport("user32.dll")]
        static extern bool PeekMessage(out MSG message, IntPtr window, uint min, uint max, uint remove);

        /// <summary>One watched window; a target is the pair, not the process.</summary>
        internal struct Target
        {
            public int Pid;
            public long WindowId;
            public string Key { get { return Pid + ":" + WindowId; } }
        }

        /// <summary>One attempt to run the input hooks; kept until its thread has ended.</summary>
        sealed class HookWorker
        {
            public Thread Thread;
            public volatile uint ThreadId;
            public volatile bool Cancelled;
            public volatile bool Installed;
            public string Failure;
            public readonly ManualResetEvent Ready = new ManualResetEvent(false);
        }

        readonly BlockingCollection<Action> inbox = new BlockingCollection<Action>();
        readonly SignalOutbox outbox;
        readonly Thread owner;
        /// <summary>Held only while enqueueing, never across I/O or UI Automation.</summary>
        readonly object attribution = new object();

        // Owned by the owner thread.
        string watchId;
        List<Target> targets = new List<Target>();
        readonly Dictionary<string, bool> active = new Dictionary<string, bool>();
        AutomationFocusChangedEventHandler focusHandler;
        HookWorker hooks;
        HookProc keyboardProc, mouseProc;

        // Hook callbacks read these under attribution.
        string inputWatch;
        int focusPending;
        long lastKeyboard, lastPointer;
        int sawKeyboard, sawPointer;

        public Signals(Action<Dictionary<string, object>> emit)
        {
            outbox = new SignalOutbox(emit);
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
                outbox.Add(reply, null);
                return;
            }
            var next = new HashSet<string>();
            foreach (Target target in nextTargets) next.Add(target.Key);
            lock (attribution)
            {
                foreach (Target target in targets)
                    if (!next.Contains(target.Key)) Clear(target);
                watchId = nextWatchId;
                targets = nextTargets;
                active.Clear();
                inputWatch = nextWatchId;
                outbox.Add(reply, null);
            }
            Reconcile(true);
        }

        void DoUnwatch(Dictionary<string, object> reply)
        {
            lock (attribution)
            {
                foreach (Target target in targets) Clear(target);
                watchId = null;
                inputWatch = null;
                targets = new List<Target>();
                active.Clear();
                outbox.Add(reply, null);
            }
            StopListening();
        }

        /// <summary>A private target that leaves the watch gets active:false under the watch it leaves.</summary>
        void Clear(Target target)
        {
            bool was;
            if (watchId != null && active.TryGetValue(target.Key, out was) && was)
                outbox.Add(Frame(watchId, PrivateMode(target, false)), PrivateKey(watchId, target));
            active[target.Key] = false;
        }

        /// <summary>
        /// Reads focus now and reports each target whose state changed; every target when the
        /// watch has just started. Focus UI Automation cannot read counts as private. A target
        /// whose window is gone, or now belongs to another process, is no longer private.
        /// </summary>
        void Reconcile(bool all)
        {
            if (watchId == null) return;
            int pid;
            bool password;
            bool known = WindowsFacts.Focus(out pid, out password);
            foreach (Target target in targets)
            {
                int owner;
                IntPtr window = new IntPtr(target.WindowId);
                bool exists = NativeMethods.IsWindow(window) &&
                    NativeMethods.GetWindowThreadProcessId(window, out owner) != 0 && owner == target.Pid;
                bool now = exists && (!known || (password && pid == target.Pid));
                bool was;
                if (!all && active.TryGetValue(target.Key, out was) && was == now) continue;
                active[target.Key] = now;
                outbox.Add(Frame(watchId, PrivateMode(target, now)), PrivateKey(watchId, target));
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
            string failure = StartHooks();
            if (failure != null) return failure;
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
            if (hooks != null) Cancel(hooks);
        }

        /// <summary>Ends a hook attempt; it is forgotten only once its thread has ended.</summary>
        void Cancel(HookWorker worker)
        {
            worker.Cancelled = true;
            uint threadId = worker.ThreadId;
            if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            if (worker.Thread.Join(2000) && hooks == worker) hooks = null;
        }

        /// <summary>
        /// Installs both hooks on a thread that pumps their messages, or neither. An attempt that
        /// times out is cancelled and kept until its thread ends, and no new one starts meanwhile.
        /// </summary>
        string StartHooks()
        {
            if (hooks != null)
            {
                if (hooks.Installed && !hooks.Cancelled && hooks.Thread.IsAlive) return null;
                if (hooks.Thread.IsAlive) return "An earlier attempt to start the input hooks has not ended yet. Try again.";
                hooks = null;
            }
            var worker = new HookWorker();
            keyboardProc = OnKeyboard;
            mouseProc = OnMouse;
            worker.Thread = new Thread(delegate () { RunHooks(worker); });
            worker.Thread.IsBackground = true;
            hooks = worker;
            worker.Thread.Start();
            if (!worker.Ready.WaitOne(2000))
            {
                Cancel(worker);
                return "The input hooks did not start in time.";
            }
            if (worker.Failure != null)
            {
                worker.Thread.Join(2000);
                if (!worker.Thread.IsAlive) hooks = null;
                return worker.Failure;
            }
            return null;
        }

        void RunHooks(HookWorker worker)
        {
            IntPtr keyboard = IntPtr.Zero, mouse = IntPtr.Zero;
            try
            {
                MSG message;
                // Creates this thread's message queue, so a quit posted from now on arrives.
                PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
                worker.ThreadId = GetCurrentThreadId();
                if (worker.Cancelled) return;
                IntPtr module = GetModuleHandle(null);
                keyboard = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
                mouse = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
                if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero)
                {
                    worker.Failure = "Windows refused the input hooks (" + Marshal.GetLastWin32Error() + "), so a person's input could not be noticed.";
                    return;
                }
                if (worker.Cancelled) return;
                worker.Installed = true;
                worker.Ready.Set();
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
            }
            finally
            {
                if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
                if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
                worker.Installed = false;
                worker.Ready.Set();
            }
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

        /// <summary>
        /// Runs inside the hook: no I/O, only the short attribution lock around an enqueue, so the
        /// event lands on the right side of any watch answer.
        /// </summary>
        void Human(string source, ref long last, ref int seen)
        {
            long now = Stopwatch.GetTimestamp();
            if (Interlocked.Exchange(ref seen, 1) == 1 && now - Interlocked.Read(ref last) < HumanInputInterval) return;
            Interlocked.Exchange(ref last, now);
            var signal = new Dictionary<string, object>();
            signal["type"] = "humanInput";
            signal["source"] = source;
            lock (attribution)
            {
                if (inputWatch == null) return;
                outbox.Add(Frame(inputWatch, signal), inputWatch + "|human|" + source);
            }
        }

        static string PrivateKey(string forWatch, Target target)
        {
            return forWatch + "|private|" + target.Key;
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