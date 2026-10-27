/**
 * The desktop rewrote the manifest for a newly approved app. A driver reads it only when it
 * starts, so an idle child is replaced before a call is judged; every check after this one sees
 * the new child. A stalled child (one that stopped answering) is replaced the same way.
 */
import * as Effect from "effect/Effect";
import { type Interruption, LEASE_END_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";

/** Built once; state is read through getters each time it runs. */
export const refreshDriverManifest = Effect.fn("ComputerUseLeaseProxy.refreshManifest")(function* <
  E,
>(input: {
  readonly stamp: (() => string | undefined) | undefined;
  readonly current: () => Running | undefined;
  readonly stalled: () => Running | undefined;
  /** No pause, end, idle turn or call in flight. */
  readonly quiet: () => boolean;
  readonly stopped: () => boolean;
  readonly interrupt: (cause: Interruption) => Effect.Effect<number>;
  readonly start: (token: number) => Effect.Effect<void, E>;
}) {
  const before = input.current();
  if (input.stamp === undefined || before === undefined || !input.quiet()) return undefined;
  const manifest = input.stamp();
  const stale = manifest !== undefined && manifest !== before.manifest;
  if (!stale && input.stalled() !== before) return undefined;
  const token = yield* input.interrupt({
    _tag: "other",
    detail: "helper_restarted",
    message: LEASE_END_MESSAGES.helper_restarted,
  });
  // Stopping the old child waits; an expiry or a driver exit may have ended the control.
  if (input.stopped()) return undefined;
  yield* input.start(token);
  return input.current();
});
