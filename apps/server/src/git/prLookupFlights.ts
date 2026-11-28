import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";

interface PrLookupRequest {
  readonly cwd: string;
  readonly branch: string;
  readonly refresh: boolean;
  readonly freshGitState: boolean;
  readonly confirmTerminal: boolean;
}

/**
 * Concurrent identical lookups against the same validated git state share one run; nothing is
 * kept after it settles. A caller that sees a newer epoch or read generation starts its own.
 */
export const makePrLookupFlights = Effect.fn("PrLookupFlights.make")(function* <A, E>(
  run: (request: PrLookupRequest) => Effect.Effect<A, E>,
  state: (cwd: string) => { readonly epoch: number; readonly reads: number },
) {
  // Paths and branch names cannot hold NUL, so the key carries the whole request.
  const flights = yield* Cache.make({
    lookup: (key: string) => {
      const [cwd = "", branch = "", freshGitState, confirmTerminal] = key.split("\u0000");
      return run({
        cwd,
        branch,
        refresh: false,
        freshGitState: freshGitState === "1",
        confirmTerminal: confirmTerminal === "1",
      });
    },
    capacity: 2048,
    timeToLive: 0,
  });
  return (request: PrLookupRequest) => {
    if (request.refresh) return run(request);
    const { epoch, reads } = state(request.cwd);
    const flags = [request.freshGitState, request.confirmTerminal].map((flag) =>
      flag ? "1" : "0",
    );
    return Cache.get(flights, [request.cwd, request.branch, ...flags, epoch, reads].join("\u0000"));
  };
});
