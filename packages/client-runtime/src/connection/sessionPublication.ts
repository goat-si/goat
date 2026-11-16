import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { RpcSession } from "../rpc/session.ts";
import type { PreparedConnection } from "./model.ts";

// One order across every computer in this page; only comparisons between numbers matter.
let latestPublication = 0;
const publications = new WeakMap<RpcSession, number>();
const firstPublications = new Map<EnvironmentId, number>();

export const latestSessionPublication = (): number => latestPublication;

export function recordSessionPublished(environmentId: EnvironmentId, session: RpcSession): void {
  latestPublication += 1;
  publications.set(session, latestPublication);
  if (!firstPublications.has(environmentId)) {
    firstPublications.set(environmentId, latestPublication);
  }
}

/**
 * Whether `session` replaced the computer's session after a press numbered `pressedAt`. A press
 * made before the computer's first session waited for that session, so it is not replaced.
 * A session no supervisor published, such as a test fake, never replaces one.
 */
export function replacedSincePress(
  environmentId: EnvironmentId,
  session: RpcSession,
  pressedAt: number,
): boolean {
  const published = publications.get(session) ?? 0;
  const first = firstPublications.get(environmentId) ?? Number.POSITIVE_INFINITY;
  return published > pressedAt && first <= pressedAt;
}

/** Makes a connected lease current, numbering its session before anything can read it. */
export const publishLease = Effect.fn("SessionPublication.publishLease")(
  function* (
    environmentId: EnvironmentId,
    current: {
      readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
      readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>;
    },
    lease: { readonly prepared: PreparedConnection; readonly session: RpcSession },
  ) {
    yield* SubscriptionRef.set(current.prepared, Option.some(lease.prepared));
    recordSessionPublished(environmentId, lease.session);
    yield* SubscriptionRef.set(current.session, Option.some(lease.session));
  },
  // A numbered session that never became current would end the first-session exemption early.
  Effect.uninterruptible,
);
