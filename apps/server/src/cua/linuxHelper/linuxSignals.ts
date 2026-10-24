import type { ComputerUseEvent, ComputerUseWindowTarget } from "@goat/contracts";

import type { SecureFocus } from "./atspiFocus.ts";
import type { IdleSource } from "./idleSource.ts";

/**
 * The safety signals a Linux helper raises while an agent session watches windows (#1235, D6,
 * D7). Nothing runs until watch: the focus probe and the idle counter are read only while a
 * session asks for them, and neither records what was typed.
 *
 * Private mode follows AT-SPI focus per watched window and is sent when it changes, the first
 * reading included. Focus that cannot be read counts as private, the same as observation.
 *
 * Human input comes from the desktop's idle counter: input newer than the last reading that
 * does not fall inside one of the helper's own dispatches was a person's. The counter cannot
 * tell keys from the pointer, so the source is "unknown".
 */

export const PRIVATE_MODE_EVERY_MS = 500;
export const HUMAN_INPUT_EVERY_MS = 250;
/** Input from a dispatch can reach the idle counter a little after the driver answers. */
const DISPATCH_TAIL_MS = 500;
/** At most one human input event per this long; the server pauses on the first anyway. */
const HUMAN_INPUT_QUIET_MS = 1_000;

export interface SignalMonitorDependencies {
  readonly secureFocus: (pid: number) => Promise<SecureFocus>;
  /** Undefined when this desktop offers no idle counter: humanInput is unsupported. */
  readonly idle: IdleSource | undefined;
  readonly now: () => number;
  /** Runs task every ms until the returned function is called. */
  readonly every: (ms: number, task: () => Promise<void>) => () => void;
  readonly emit: (event: ComputerUseEvent) => void;
}

export interface SignalMonitor {
  readonly watch: (targets: ReadonlyArray<ComputerUseWindowTarget>) => void;
  readonly unwatch: () => void;
  readonly watching: () => ReadonlyArray<ComputerUseWindowTarget>;
  /** Marks a span in which input the helper sent may reset the idle counter. */
  readonly dispatching: () => () => void;
}

export function makeSignalMonitor(deps: SignalMonitorDependencies): SignalMonitor {
  let targets: ReadonlyArray<ComputerUseWindowTarget> = [];
  const privateState = new Map<string, boolean>();
  const spans: Array<{ start: number; end: number | undefined }> = [];
  let stops: Array<() => void> = [];
  let lastInputAt = 0;
  let lastEventAt = -Infinity;
  let reading = { focus: false, idle: false };

  const ours = (at: number) =>
    spans.some(({ start, end }) => at >= start && (end === undefined || at <= end + DISPATCH_TAIL_MS));

  const checkFocus = async () => {
    if (reading.focus) return;
    reading.focus = true;
    try {
      for (const target of targets) {
        const focus = await deps.secureFocus(target.pid);
        const active = focus.secure || !focus.known;
        const key = target.pid + ":" + target.windowId;
        if (privateState.get(key) === active) continue;
        const first = !privateState.has(key);
        privateState.set(key, active);
        // A first reading that is not private says nothing new.
        if (!first || active) deps.emit({ type: "privateMode", active, target });
      }
    } finally {
      reading.focus = false;
    }
  };

  const checkIdle = async () => {
    const idle = deps.idle;
    if (!idle || reading.idle) return;
    reading.idle = true;
    try {
      const ms = await idle.idleMs();
      if (ms === undefined) return;
      const now = deps.now();
      const inputAt = now - ms;
      // Readings jitter by a few milliseconds; only a clearly newer input counts.
      if (inputAt <= lastInputAt + 20) return;
      lastInputAt = inputAt;
      const cutoff = now - 5 * DISPATCH_TAIL_MS;
      while (spans.length > 0 && (spans[0]?.end ?? Infinity) < cutoff) spans.shift();
      if (ours(inputAt) || now - lastEventAt < HUMAN_INPUT_QUIET_MS) return;
      lastEventAt = now;
      deps.emit({ type: "humanInput", source: "unknown" });
    } finally {
      reading.idle = false;
    }
  };

  const stop = () => {
    for (const cancel of stops) cancel();
    stops = [];
  };

  return {
    watch: (next) => {
      stop();
      targets = [...next];
      privateState.clear();
      // Input before the session started is not this session's concern.
      lastInputAt = deps.now();
      lastEventAt = -Infinity;
      reading = { focus: false, idle: false };
      stops = [
        deps.every(PRIVATE_MODE_EVERY_MS, checkFocus),
        ...(deps.idle ? [deps.every(HUMAN_INPUT_EVERY_MS, checkIdle)] : []),
      ];
      void checkFocus();
    },
    unwatch: () => {
      stop();
      targets = [];
      privateState.clear();
    },
    watching: () => targets,
    dispatching: () => {
      const span: { start: number; end: number | undefined } = { start: deps.now(), end: undefined };
      spans.push(span);
      return () => {
        span.end = deps.now();
      };
    },
  };
}

