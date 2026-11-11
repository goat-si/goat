// A clock for tests: time moves only when the test advances it, and a test can await the next timer being set.
import type { Clock, Timer } from "../runtime.ts";

interface Scheduled {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Array<Scheduled> = [];
  #waiters: Array<() => void> = [];
  #delays: Array<number> = [];
  #delayWaiters: Array<{ ms: number; count: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(ms: number, fn: () => void): Timer {
    const timer: Scheduled = {
      at: this.#now + Math.max(0, ms),
      seq: this.#seq++,
      fn,
      cancelled: false,
    };
    this.#timers.push(timer);
    for (const wake of this.#waiters.splice(0)) wake();
    this.#delays.push(ms);
    for (const waiter of this.#delayWaiters.slice()) {
      if (this.#delays.filter((delay) => delay === waiter.ms).length >= waiter.count) {
        this.#delayWaiters.splice(this.#delayWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Live timers, earliest first. */
  pending(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  /** Resolves when a timer is set (at once if one is already pending). */
  nextTimer(): Promise<void> {
    if (this.pending() > 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Resolves once `count` timers with this delay have been set since the clock was made. */
  whenTimer(ms: number, count = 1): Promise<void> {
    if (this.#delays.filter((delay) => delay === ms).length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#delayWaiters.push({ ms, count, resolve }));
  }

  /** Moves time forward, running every timer due on the way, in order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.#now = due.at;
      due.cancelled = true;
      this.#timers = this.#timers.filter((timer) => !timer.cancelled);
      due.fn();
    }
    this.#now = target;
  }
}
