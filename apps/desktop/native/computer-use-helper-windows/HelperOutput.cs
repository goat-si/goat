// Every line the helper writes to the host goes through this queue and one writer thread, so no
// request, event or capture ever waits on stdout. A host that stops reading stalls only the
// writer: the stdin loop still sees EOF and stops the driver. While output backs up, only the
// newest few frames are kept; answers, events and reasons are never dropped, and order holds.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Goat.ComputerUse
{
    internal sealed class HelperOutput
    {
        const int MaxQueuedFrames = 4;

        sealed class Line
        {
            public byte[] Bytes;
            public bool Frame;
        }

        readonly Stream output;
        readonly LinkedList<Line> pending = new LinkedList<Line>();
        bool writing;
        bool broken;

        public HelperOutput(Stream output)
        {
            this.output = output;
            var writer = new Thread(Write);
            writer.IsBackground = true;
            writer.Start();
        }

        /// <summary>Queues one line; returns at once. frame lines are the ones that may be dropped.</summary>
        public void Add(byte[] line, bool frame)
        {
            lock (pending)
            {
                if (broken) return;
                if (frame && pending.Count(queued => queued.Frame) >= MaxQueuedFrames)
                    pending.Remove(pending.First(queued => queued.Frame));
                pending.AddLast(new Line { Bytes = line, Frame = frame });
                Monitor.PulseAll(pending);
            }
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

        void Write()
        {
            while (true)
            {
                Line next;
                lock (pending)
                {
                    while (pending.Count == 0) Monitor.Wait(pending);
                    next = pending.First.Value;
                    pending.RemoveFirst();
                    writing = true;
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
                        broken = true;
                        pending.Clear();
                        writing = false;
                        Monitor.PulseAll(pending);
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
