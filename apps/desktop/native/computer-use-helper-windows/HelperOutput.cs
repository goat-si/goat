// Every line the helper writes to the host goes through this queue and one writer thread, so no
// request reply or capture ever waits on stdout: a host that stops reading stalls only the
// writer, and the stdin loop still sees EOF and stops the driver. While output backs up:
// - frames keep only the newest few;
// - signals (AddPaced) wait once a short backlog is queued, so they pile up in SignalOutbox,
//   where unsent state for the same target or input source coalesces;
// - replies and reasons are never dropped. A backlog past the limits means the host is not
//   reading at all: the helper stops its driver and exits (onOverload) instead of growing.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Goat.ComputerUse
{
    internal sealed class HelperOutput
    {
        const int MaxQueuedFrames = 4;
        /// <summary>Signals wait while this many other lines are queued.</summary>
        const int PacedBacklog = 64;
        const int MaxPendingLines = 4096;
        const long MaxPendingBytes = 64L * 1024 * 1024;

        sealed class Line
        {
            public byte[] Bytes;
            public bool Frame;
        }

        readonly Stream output;
        readonly Action onOverload;
        readonly LinkedList<Line> pending = new LinkedList<Line>();
        int frames;
        long bytes;
        bool writing;
        bool broken;

        public HelperOutput(Stream output, Action onOverload)
        {
            this.output = output;
            this.onOverload = onOverload;
            var writer = new Thread(Write);
            writer.IsBackground = true;
            writer.Start();
        }

        /// <summary>Queues one line and returns at once; a frame line may be dropped for a newer one.</summary>
        public void Add(byte[] line, bool frame)
        {
            bool overloaded;
            lock (pending)
            {
                if (broken) return;
                if (frame && frames >= MaxQueuedFrames)
                {
                    LinkedListNode<Line> node = pending.First;
                    while (!node.Value.Frame) node = node.Next;
                    Remove(node);
                }
                pending.AddLast(new Line { Bytes = line, Frame = frame });
                if (frame) frames++;
                bytes += line.Length;
                Monitor.PulseAll(pending);
                overloaded = pending.Count - frames > MaxPendingLines || bytes > MaxPendingBytes;
                if (overloaded) Break();
            }
            if (overloaded)
            {
                // Not on this thread: it may be the stdin loop or a capture holding its own lock.
                var stop = new Thread(delegate () { onOverload(); });
                stop.IsBackground = true;
                stop.Start();
            }
        }

        /// <summary>
        /// Queues a signal line, first waiting while a backlog is queued, so a stalled reader
        /// leaves signals coalescing upstream. Only the signal writer thread calls this.
        /// </summary>
        public void AddPaced(byte[] line)
        {
            lock (pending)
            {
                while (!broken && pending.Count - frames >= PacedBacklog) Monitor.Wait(pending);
            }
            Add(line, false);
        }

        /// <summary>Waits up to milliseconds for everything queued to be written, before exiting.</summary>
        public void Drain(int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            lock (pending)
            {
                while ((pending.Count > 0 || writing) && !broken)
                {
                    TimeSpan left = deadline - DateTime.UtcNow;
                    if (left <= TimeSpan.Zero) return;
                    Monitor.Wait(pending, left);
                }
            }
        }

        void Remove(LinkedListNode<Line> node)
        {
            pending.Remove(node);
            if (node.Value.Frame) frames--;
            bytes -= node.Value.Bytes.Length;
        }

        /// <summary>Nothing more reaches the host; waiters wake. Called under pending.</summary>
        void Break()
        {
            broken = true;
            pending.Clear();
            frames = 0;
            bytes = 0;
            Monitor.PulseAll(pending);
        }

        void Write()
        {
            while (true)
            {
                Line next;
                lock (pending)
                {
                    while (pending.Count == 0)
                    {
                        if (broken) return;
                        Monitor.Wait(pending);
                    }
                    next = pending.First.Value;
                    Remove(pending.First);
                    writing = true;
                    Monitor.PulseAll(pending);
                }
                try
                {
                    output.Write(next.Bytes, 0, next.Bytes.Length);
                    output.Flush();
                }
                catch (IOException)
                {
                    // The host closed stdout; nothing more can reach it.
                    lock (pending)
                    {
                        writing = false;
                        Break();
                    }
                    return;
                }
                lock (pending)
                {
                    writing = false;
                    Monitor.PulseAll(pending);
                }
            }
        }
    }
}
