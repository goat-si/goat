import { LOGIN_SHELL_RETRY_DELAYS_MS } from "@goat/shared/cliPath";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/** Probe processes whose exit has not been observed yet. */
export interface LiveShellProbes {
  /** Counts the probe from its start until it has finished, the kill and wait for exit included. */
  readonly track: <A, E, R>(probe: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly allGone: Effect.Effect<boolean>;
}

export const makeLiveShellProbes = Effect.gen(function* () {
  const live = yield* Ref.make(0);
  return {
    track: (probe) =>
      Effect.acquireUseRelease(
        Ref.update(live, (count) => count + 1),
        () => probe,
        () => Ref.update(live, (count) => count - 1),
      ),
    allGone: Ref.get(live).pipe(Effect.map((count) => count === 0)),
  } satisfies LiveShellProbes;
});

/** The desktop service provides its own; a probe run outside it is not counted. */
export const LiveShellProbes = Context.Reference<LiveShellProbes>(
  "@goat/desktop/shell/LiveShellProbes",
  { defaultValue: () => ({ track: (probe) => probe, allGone: Effect.succeed(true) }) },
);

const warn = (message: string) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ component: "desktop-shell-environment" }));

/**
 * Runs one discovery, then a fixed number of further ones with growing gaps until one succeeds.
 * A further one starts only when every earlier probe process is known to have exited, so a shell
 * that would not die never gets company: the retries end there. Windows keeps its single probe.
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
        yield* warn("A login shell probe has not exited; GOAT will not probe again this session.");
        return false;
      }
      if (yield* discover) return true;
    }
    yield* warn("The login shell never answered with a PATH; no further probes.");
    return false;
  },
);
