import type { ComputerUseEvent, ComputerUseWindowTarget } from "@goat/contracts";

import type { SecureFocus } from "./atspiFocus.ts";
import type { HumanInputSource } from "./humanInputSource.ts";

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
 * Human input comes from the person's own input devices (humanInputSource.ts), which already
 * leaves out the helper's own input, so nothing here guesses by timing. If that source breaks,
 * the watch cannot see a person any more: it reports human input once, which pauses agents,
 * and tells the helper, which ends so a restart reports the signal unsupported.
 */

const PRIVATE_MODE_EVERY_MS = 500;
const HUMAN_INPUT_EVERY_MS = 250;
/** A focus probe slower than this counts as unreadable, which is private. */
const FOCUS_PROBE_LIMIT_MS = 3_000;
const UNREADABLE: SecureFocus = { known: false, secure: false, windows: 0 };
/** At most one human input event per this long; the server pauses on the first anyway. */
const HUMAN_INPUT_QUIET_MS = 1_000;

export interface SignalMonitorDependencies {
  readonly secureFocus: (pid: number) => Promise<SecureFocus>;
  /** False once the window is gone; undefined when that cannot be told right now. */
  readonly windowOpen: (target: ComputerUseWindowTarget) => Promise<boolean | undefined>;
  /** Undefined when this desktop offers no way to see a person's input: humanInput is unsupported. */
  readonly input: HumanInputSource | undefined;
  /** The input source broke; the helper ends after the pause it caused goes out. */
  readonly inputLost: () => void;
  /** A monotonic clock, for spacing human input events; never wall time, which can step back. */
  readonly now: () => number;
  /** Runs task every ms until the returned function is called. */
  readonly every: (ms: number, task: () => Promise<void>) => () => void;
  /** Resolves after ms; bounds a focus probe that does not answer. */
  readonly delay: (ms: number) => Promise<void>;
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
}

const keyOf = (target: ComputerUseWindowTarget) => target.pid + ":" + target.windowId;

export function makeSignalMonitor(deps: SignalMonitorDependencies): SignalMonitor {
  let watchId: string | undefined;
  // Every watch and unwatch starts a new incarnation: a watch id can be reused, so deferred
  // work and running checks compare this, never the id.
  let incarnation = 0;
  let targets: ComputerUseWindowTarget[] = [];
  const active = new Map<string, boolean>();
  let stops: Array<() => void> = [];
  let lastInputOrder = 0;
  let lostReported = false;
  let lastEventAt = -Infinity;
  /** Targets whose focus check is running; each target is checked on its own. */
  // Each running check owns its target's entry, so a check left over from an earlier watch
  // never releases the entry a newer check holds.
  const checking = new Map<string, object>();

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
    const focus = await Promise.race([
      deps.secureFocus(target.pid),
      deps.delay(FOCUS_PROBE_LIMIT_MS).then(() => UNREADABLE),
    ]);
    // The watch may have changed while AT-SPI answered.
    if (incarnation !== mine || !targets.includes(target)) return;
    const now = focus.secure || !focus.known;
    const key = keyOf(target);
    if (!report && active.get(key) === now) return;
    active.set(key, now);
    deps.emit(id, { type: "privateMode", active: now, target });
  };

  /**
   * One target's check: first its initial report, then changes. Targets run independently, so
   * one slow probe never holds back another window's private mode or human input.
   */
  const checkTarget = async (
    id: string,
    mine: number,
    target: ComputerUseWindowTarget,
    initial: boolean,
  ) => {
    const key = keyOf(target);
    if (checking.has(key)) return;
    const owner = {};
    checking.set(key, owner);
    try {
      if (!initial) {
        const open = await deps.windowOpen(target);
        if (incarnation !== mine) return;
        // Only a list that lacks the window proves it closed; an error proves nothing.
        if (open === false) {
          release(id, target);
          targets = targets.filter((entry) => entry !== target);
          return;
        }
      }
      await readFocus(id, mine, target, initial);
    } finally {
      if (checking.get(key) === owner) checking.delete(key);
    }
  };

  const checkFocus = async () => {
    const id = watchId;
    const mine = incarnation;
    if (id === undefined) return;
    // A target still being checked is skipped at once, so a stuck probe holds only itself.
    await Promise.all(targets.map((target) => checkTarget(id, mine, target, false)));
  };

  const checkInput = async () => {
    const input = deps.input;
    const id = watchId;
    if (!input || id === undefined) return;
    if (input.lost()) {
      if (lostReported) return;
      lostReported = true;
      // Unable to see a person, the watch fails closed: agents pause until someone hands back.
      deps.emit(id, { type: "humanInput", source: "unknown" });
      deps.inputLost();
      return;
    }
    const latest = input.latest();
    if (!latest || latest.order <= lastInputOrder) return;
    lastInputOrder = latest.order;
    const now = deps.now();
    if (now - lastEventAt < HUMAN_INPUT_QUIET_MS) return;
    lastEventAt = now;
    deps.emit(id, { type: "humanInput", source: latest.source });
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
      for (const key of Array.from(active.keys())) if (!kept.has(key)) active.delete(key);
      // Input from before this watch is not its concern.
      lastInputOrder = deps.input?.latest()?.order ?? 0;
      lastEventAt = -Infinity;
      checking.clear();
      deps.afterReply(async () => {
        if (incarnation !== mine) return;
        // Each target's first report starts now and marks it as being checked, so the timer
        // never reports a change before it; human input is watched from the same moment, not
        // after the slowest first report.
        const initial = targets.map((target) => checkTarget(id, mine, target, true));
        stops = [
          deps.every(PRIVATE_MODE_EVERY_MS, checkFocus),
          ...(deps.input ? [deps.every(HUMAN_INPUT_EVERY_MS, checkInput)] : []),
        ];
        await Promise.all(initial);
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
  };
}
