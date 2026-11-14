import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { SessionStore } from "../auth/SessionStore.ts";
import { PenMembershipWatch } from "./PenMembershipWatch.ts";

const RETRY = { schedule: Schedule.exponential("1 second"), times: 6 };

/**
 * Keeps the sessions other Pen members hold on this server in step with this machine's Pen
 * membership. The fence in SessionStore is the enforcement and starts closed; this only tells it
 * who is a member now, and revokes for good what a departed member held. Pen being down closes
 * the fence and revokes nothing, so the same sessions work again when the member list returns.
 */
export const make = Effect.fn("PenMemberSessions.make")(function* () {
  const sessions = yield* SessionStore;

  const revokeUnless = Effect.fn("PenMemberSessions.revokeUnless")(function* (
    members: ReadonlySet<string>,
  ) {
    for (const session of yield* sessions.listPenMemberSessions)
      if (!members.has(session.penMemberNode)) yield* sessions.revoke(session.sessionId);
  });

  const apply = Effect.fn("PenMemberSessions.apply")(function* (view: PenMembershipView) {
    if (view.kind === "unavailable") return yield* sessions.setPenMembersAdmitted("closed");
    const members =
      view.kind === "ready"
        ? new Set(view.snapshot.members.map((member) => member.nodeId))
        : new Set<string>();
    // The fence first: a failed or slow cleanup never leaves a departed member admitted.
    yield* sessions.setPenMembersAdmitted(view.kind === "ready" ? members : "closed");
    yield* revokeUnless(members).pipe(
      // A list that could not be read arrives as a defect; it is retried like any failure.
      Effect.sandbox,
      Effect.retry(RETRY),
      Effect.catchCause((cause) => Effect.logWarning("pen.memberSessions.cleanup.failed", cause)),
    );
  });
  return { apply };
});

const follow = Effect.gen(function* () {
  const { apply } = yield* make();
  const watch = yield* PenMembershipWatch;
  // A newer view interrupts the cleanup of an older one; the fence is already set by then.
  yield* watch.changes.pipe(
    Stream.switchMap((view) => Stream.fromEffect(apply(view))),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

/** Runs on every server, whatever the Pen settings say: it only ever narrows who may sign in. */
export const layer = Layer.effectDiscard(follow);
