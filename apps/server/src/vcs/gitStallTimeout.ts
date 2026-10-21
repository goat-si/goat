import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/** What a stalled Git command was doing when GOAT stopped waiting for it. */
export interface GitStall {
  readonly elapsedMs: number;
  readonly idleMs: number;
  readonly lastOutput: string | null;
}

export interface GitStallWatch {
  /** Records a line of output; any output counts as progress. */
  readonly touch: (line: string) => Effect.Effect<void>;
}

/**
 * Runs `body` until it finishes or goes `stallMs` without output.
 *
 * A Windows checkout under real-time antivirus scanning, or a post-checkout hook
 * installing dependencies, can take many minutes while printing steadily. A fixed
 * wall-clock limit kills those healthy commands; only silence means Git is stuck.
 */
export const withGitStallTimeout = Effect.fn("GitVcsDriver.withStallTimeout")(function* <
  A,
  E,
  R,
  E2,
>(
  stallMs: number,
  onStall: (stall: GitStall) => E2,
  body: (watch: GitStallWatch) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | E2, R> {
  const startedAt = yield* Clock.currentTimeMillis;
  const last = yield* Ref.make<{ readonly at: number; readonly line: string | null }>({
    at: startedAt,
    line: null,
  });
  const touch = (line: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const trimmed = line.trim();
        return Ref.update(last, (previous) => ({
          at: now,
          line: trimmed.length > 0 ? trimmed : previous.line,
        }));
      }),
    );
  const watchdog = Effect.gen(function* () {
    while (true) {
      const { at, line } = yield* Ref.get(last);
      const now = yield* Clock.currentTimeMillis;
      const idleMs = now - at;
      if (idleMs >= stallMs) {
        return yield* Effect.fail(
          onStall({ elapsedMs: now - startedAt, idleMs, lastOutput: line }),
        );
      }
      yield* Effect.sleep(stallMs - idleMs);
    }
  });
  return yield* Effect.raceFirst(body({ touch }), watchdog);
});

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

const LAST_OUTPUT_MAX_LENGTH = 200;

export function describeGitStall(stall: GitStall): string {
  const last =
    stall.lastOutput === null
      ? "It printed nothing."
      : `Last output: ${
          stall.lastOutput.length > LAST_OUTPUT_MAX_LENGTH
            ? `${stall.lastOutput.slice(0, LAST_OUTPUT_MAX_LENGTH - 1)}\u2026`
            : stall.lastOutput
        }`;
  return `Git made no progress for ${formatDuration(stall.idleMs)} and was stopped after ${formatDuration(stall.elapsedMs)}. ${last}`;
}
