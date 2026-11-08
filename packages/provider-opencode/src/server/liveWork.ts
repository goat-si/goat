import * as Effect from "effect/Effect";

/**
 * Live work an idle or retiring release must not cut off: a pending request, or a session of this
 * runtime still running. Past the pin ceiling OpenCode confirms the running sessions, and a server
 * that cannot answer holds nothing, so a dead server never pins its session.
 */
export const openCodeLiveWork =
  <E>(
    hasPendingRequest: () => boolean,
    running: () => Iterable<string>,
    active: () => Effect.Effect<
      Readonly<Record<string, { readonly type?: string } | undefined>>,
      E
    >,
  ) =>
  (input: { readonly pastPinCeiling: boolean }): Effect.Effect<boolean> => {
    if (hasPendingRequest()) return Effect.succeed(true);
    const ids = [...running()];
    if (ids.length === 0 || !input.pastPinCeiling) return Effect.succeed(ids.length > 0);
    return active().pipe(
      Effect.map((sessions) => ids.some((id) => (sessions[id]?.type ?? "idle") !== "idle")),
      Effect.orElseSucceed(() => false),
    );
  };
