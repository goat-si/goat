import type { ComputerUseEvent, ComputerUseWindowTarget } from "@goat/contracts";

import type { SecureFocus } from "./atspiFocus.ts";
import type { IdleSource } from "./idleSource.ts";

/**
 * The safety signals a Linux helper raises while an agent session watches windows (#1235, D6,
 * D7). Nothing runs until watch: the focus probe and the idle counter are read only while a
 * session asks for them, and neither records what was typed.
 *
 * Private mode follows AT-SPI focus per watched window. Right after a watch is answered, every
 * target's state is reported once; after that, only changes. Focus that cannot be read counts
 * as private, as in observation. Before a target leaves (its window closes, a new watch drops
 * it, or unwatch), an active one is reported inactive under the watch it belonged to, and the
 * new watch or unwatch is answered only after that.
 *
 * Human input comes from the desktop's idle counter: input newer than the last reading that
 * does not fall inside one of the helper's own dispatches was a person's. The counter cannot
 * tell keys from the pointer, so the source is "unknown".
 */

const PRIVATE_MODE_EVERY_MS = 500;
const HUMAN_INPUT_EVERY_MS = 250;
/** Input from a dispatch can reach the idle counter a little after the driver answers. */
const DISPATCH_TAIL_MS = 500;
/** At most one human input event per this long; the server pauses on the first anyway. */
const HUMAN_INPUT_QUIET_MS = 1_000;

export interface SignalMonitorDependencies {
  readonly secureFocus: (pid: number) => Promise<SecureFocus>;
  /** False once the window is gone; undefined when that cannot be told right now. */
  readonly windowOpen: (target: ComputerUseWindowTarget) => Promise<boolean | undefined>;
  /** Undefined when this desktop offers no idle counter: humanInput is unsupported. */
  readonly idle: IdleSource | undefined;
  readonly now: () => number;
  /** Runs task every ms until the returned function is called. */
  readonly every: (ms: number, task: () => Promise<void>) => () => void;
  /** Runs task after the current reply has been written. */
  readonly afterReply: (task: () => Promise<void>) => void;
  readonly emit: (watchId: string, event: ComputerUseEvent) => void;
}

export interface SignalMonitor {
  /** Ends the current watch's targets that are not in the new one, then starts it. */
  readonly watch: (
    watchId: string,
    targets: ReadonlyArray<ComputerUseWindowTarget>,
  ) => Promise<void>;
  /** Clears every active target, then stops reading. */
  readonly unwatch: () => Promise<void>;
  readonly watching: () => ReadonlyArray<ComputerUseWindowTarget>;
  /** Marks a span in which input the helper sent may reset the idle counter. */
  readonly dispatching: () => () => void;
}

const keyOf = (target: ComputerUseWindowTarget) => target.pid + ":" + target.windowId;

export function makeSignalMonitor(deps: SignalMonitorDependencies): SignalMonitor {
  let watchId: string | undefined;
  // Every watch and unwatch starts a new incarnation: a watch id can be reused, so deferred
  // work and running checks compare this, never the id.
  let incarnation = 0;
  let targets: ComputerUseWindowTarget[] = [];
  const active = new Map<string, boolean>();
  const spans: Array<{ start: number; end: number | undefined }> = [];
  let stops: Array<() => void> = [];
  let lastInputAt = 0;
  let lastEventAt = -Infinity;
  let busy = { focus: false, idle: false };

  const ours = (at: number) =>
    spans.some(
      ({ start, end }) => at >= start && (end === undefined || at <= end + DISPATCH_TAIL_MS),
    );

  /** Reports a target inactive if it was active, and forgets it. */
  const release = (id: string, target: ComputerUseWindowTarget) => {
    const key = keyOf(target);
    if (active.get(key)) deps.emit(id, { type: "privateMode", active: false, target });
    active.delete(key);
  };

  const readFocus = async (
    id: string,
    mine: number,
    target: ComputerUseWindowTarget,
    report: boolean,
  ) => {
    const focus = await deps.secureFocus(target.pid);
    // The watch may have changed while AT-SPI answered.
    if (incarnation !== mine || !targets.includes(target)) return;
    const now = focus.secure || !focus.known;
    const key = keyOf(target);
    if (!report && active.get(key) === now) return;
    active.set(key, now);
    deps.emit(id, { type: "privateMode", active: now, target });
  };

  const checkFocus = async () => {
    const id = watchId;
    const mine = incarnation;
    if (id === undefined || busy.focus) return;
    busy.focus = true;
    try {
      for (const target of targets) {
        const open = await deps.windowOpen(target);
        if (incarnation !== mine) return;
        // Only a list that lacks the window proves it closed; an error proves nothing.
        if (open === false) {
          release(id, target);
          targets = targets.filter((entry) => entry !== target);
          continue;
        }
        await readFocus(id, mine, target, false);
      }
    } finally {
      busy.focus = false;
    }
  };

  const checkIdle = async () => {
    const idle = deps.idle;
    const id = watchId;
    const mine = incarnation;
    if (!idle || id === undefined || busy.idle) return;
    busy.idle = true;
    try {
      const ms = await idle.idleMs();
      if (ms === undefined || incarnation !== mine) return;
      const now = deps.now();
      const inputAt = now - ms;
      // Readings jitter by a few milliseconds; only a clearly newer input counts.
      if (inputAt <= lastInputAt + 20) return;
      lastInputAt = inputAt;
      while (spans.length > 0 && (spans[0]?.end ?? Infinity) < now - 5 * DISPATCH_TAIL_MS)
        spans.shift();
      if (ours(inputAt) || now - lastEventAt < HUMAN_INPUT_QUIET_MS) return;
      lastEventAt = now;
      deps.emit(id, { type: "humanInput", source: "unknown" });
    } finally {
      busy.idle = false;
    }
  };

  const stop = () => {
    for (const cancel of stops) cancel();
    stops = [];
  };

  return {
    watch: async (id, next) => {
      stop();
      const previous = watchId;
      const kept = new Set(next.map(keyOf));
      if (previous !== undefined)
        for (const target of targets) if (!kept.has(keyOf(target))) release(previous, target);
      watchId = id;
      const mine = ++incarnation;
      targets = [...next];
      // A retained target keeps its state until its first reading under this watch, so an
      // unwatch before then still clears it.
      for (const key of [...active.keys()]) if (!kept.has(key)) active.delete(key);
      // Input from before this watch is not its concern.
      lastInputAt = deps.now();
      lastEventAt = -Infinity;
      busy = { focus: false, idle: false };
      deps.afterReply(async () => {
        if (incarnation !== mine) return;
        await Promise.all(targets.map((target) => readFocus(id, mine, target, true)));
        if (incarnation !== mine) return;
        stops = [
          deps.every(PRIVATE_MODE_EVERY_MS, checkFocus),
          ...(deps.idle ? [deps.every(HUMAN_INPUT_EVERY_MS, checkIdle)] : []),
        ];
      });
    },
    unwatch: async () => {
      stop();
      incarnation++;
      if (watchId !== undefined) for (const target of targets) release(watchId, target);
      watchId = undefined;
      targets = [];
    },
    watching: () => targets,
    dispatching: () => {
      const span: { start: number; end: number | undefined } = {
        start: deps.now(),
        end: undefined,
      };
      spans.push(span);
      return () => {
        span.end = deps.now();
      };
    },
  };
}
