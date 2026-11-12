import { LOGIN_SHELL_RETRY_DELAYS_MS } from "@goat/shared/cliPath";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";

type ProbeProcess = Pick<ChildProcessSpawner.ChildProcessHandle, "isRunning">;

/** Probe processes whose exit has not been observed yet. */
export interface LiveShellProbes {
  /** Counts the probe from its start until it has finished, so one that has not spawned yet counts. */
  readonly track: <A, E, R>(probe: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Keeps the spawned process counted until its exit is observed. The probe's cleanup ending is
   * not that: the spawner ignores a failed termination, which leaves the process running.
   * A spawn interrupted before it handed back a process may have started one nobody can watch.
   */
  readonly spawned: <Handle extends ProbeProcess, E, R>(
    spawn: Effect.Effect<Handle, E, R>,
  ) => Effect.Effect<Handle, E, R>;
  readonly allGone: Effect.Effect<boolean>;
}

export const makeLiveShellProbes = Effect.gen(function* () {
  const live = yield* Ref.make(0);
  // Holds one entry per spawned probe of a fixed number of attempts; allGone drops exited ones.
  const processes = yield* Ref.make<ReadonlyArray<ProbeProcess>>([]);
  // Set for the session by a spawn interrupted before its process could be registered.
  const exitUnknown = yield* Ref.make(false);
  return {
    track: (probe) =>
      Effect.acquireUseRelease(
        Ref.update(live, (count) => count + 1),
        () => probe,
        () => Ref.update(live, (count) => count - 1),
      ),
    spawned: (spawn) =>
      Effect.uninterruptibleMask((restore) =>
        restore(spawn).pipe(
          Effect.onInterrupt(() => Ref.set(exitUnknown, true)),
          // Only the check is kept, so a finished probe's streams are not held for the session.
          Effect.tap(({ isRunning }) => Ref.update(processes, (all) => [...all, { isRunning }])),
        ),
      ),
    allGone: Effect.gen(function* () {
      if (yield* Ref.get(exitUnknown)) return false;
      const exited = new Set<ProbeProcess>();
      for (const process of yield* Ref.get(processes)) {
        // A check that fails has not shown the process gone.
        const running = yield* process.isRunning.pipe(Effect.orElseSucceed(() => true));
        if (!running) exited.add(process);
      }
      const running = yield* Ref.updateAndGet(processes, (all) =>
        all.filter((process) => !exited.has(process)),
      );
      return running.length === 0 && (yield* Ref.get(live)) === 0;
    }),
  } satisfies LiveShellProbes;
});

/** The desktop service provides its own; a probe run outside it is not counted. */
export const LiveShellProbes = Context.Reference<LiveShellProbes>(
  "@goat/desktop/shell/LiveShellProbes",
  {
    defaultValue: () => ({
      track: (probe) => probe,
      spawned: (spawn) => spawn,
      allGone: Effect.succeed(true),
    }),
  },
);

const warn = (message: string) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ component: "desktop-shell-environment" }));

/**
 * Runs one discovery, then a fixed number of further ones with growing gaps until one succeeds.
 * A further one starts only when every earlier probe process is known to have exited; otherwise
 * the retries end there. Within one discovery the fallback shell and launchctl can still start
 * while a timed-out shell is being killed. Windows keeps its single probe.
 */
export const discoverWithRetries = Effect.fn("desktop.shellEnvironment.discoverWithRetries")(
  function* (
    discover: Effect.Effect<boolean>,
    platform: NodeJS.Platform,
    earlierProbesGone: Effect.Effect<boolean>,
  ) {
    if (yield* discover) return true;
    if (platform !== "darwin" && platform !== "linux") return false;
    for (const delay of LOGIN_SHELL_RETRY_DELAYS_MS) {
      yield* Effect.sleep(Duration.millis(delay));
      if (!(yield* earlierProbesGone)) {
        yield* warn("A login shell probe is not known to have exited; no further probes.");
        return false;
      }
      if (yield* discover) return true;
    }
    yield* warn("The login shell never answered with a PATH; no further probes.");
    return false;
  },
);
