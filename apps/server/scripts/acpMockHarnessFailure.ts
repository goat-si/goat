import * as Effect from "effect/Effect";

const mode = process.env.GOAT_ACP_ANTIGRAVITY_HARNESS_FAILURE;
export const harnessFailure = mode === "1" || mode === "pending" || mode === "after-end-turn";
export const writeHarnessFailure = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      process.stderr.write(
        "I1022 11:04:37.910207 1865358 local_connection.py:551] harness stderr: Agent run failed: failed to handle call hook response: no pending hook for ID hook_request_2\n",
        () => resolve(),
      );
    }),
);

export const handleHarnessFailure = Effect.fn("acpMock.handleHarnessFailure")(function* <A, E, R>(
  finish: Effect.Effect<A, E, R>,
) {
  if (mode !== "after-end-turn") yield* writeHarnessFailure;
  if (mode === "pending") return yield* Effect.never;
  return yield* finish;
});
