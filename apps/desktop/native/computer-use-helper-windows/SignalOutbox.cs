using System;
using System.Collections.Generic;
using System.Threading;

namespace Goat.ComputerUse
{
    /// <summary>
    /// The one queue every signal frame and watch answer leaves through, written in order by one
    /// thread. While a reader is slow, state frames coalesce instead of piling up: an unsent
    /// frame with the same key (one target's private mode under one watch, or one input source)
    /// takes the newer content in place, so what waits is bounded by the watched targets and
    /// the requests the host sent. Answers never coalesce and never drop.
    /// </summary>
    internal sealed class SignalOutbox
    {
        sealed class Entry
        {
            public Dictionary<string, object> Frame;
            public string Key;
        }

        readonly object gate = new object();
        readonly LinkedList<Entry> queue = new LinkedList<Entry>();
        readonly Dictionary<string, LinkedListNode<Entry>> unsent = new Dictionary<string, LinkedListNode<Entry>>();

        public SignalOutbox(Action<Dictionary<string, object>> emit)
        {
            var writer = new Thread(delegate ()
            {
                while (true)
                {
                    Entry next;
                    lock (gate)
                    {
                        while (queue.Count == 0) Monitor.Wait(gate);
                        next = queue.First.Value;
                        queue.RemoveFirst();
                        if (next.Key != null) unsent.Remove(next.Key);
                    }
                    emit(next.Frame);
                }
            });
            writer.IsBackground = true;
            writer.Start();
        }

        /// <summary>Appends a frame; with a key, an unsent frame under the same key is replaced where it waits.</summary>
        public void Add(Dictionary<string, object> frame, string coalesceKey)
        {
            lock (gate)
            {
                LinkedListNode<Entry> waiting;
                if (coalesceKey != null && unsent.TryGetValue(coalesceKey, out waiting))
                {
                    waiting.Value.Frame = frame;
                    return;
                }
                LinkedListNode<Entry> node = queue.AddLast(new Entry { Frame = frame, Key = coalesceKey });
                if (coalesceKey != null) unsent[coalesceKey] = node;
                Monitor.Pulse(gate);
            }
        }
    }
}
