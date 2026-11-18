import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { SessionStore } from "../auth/SessionStore.ts";
import { PenMembershipWatch, type PenMembershipMarks } from "./PenMembershipWatch.ts";

const RETRY = { schedule: Schedule.exponential("1 second"), times: 6 };

const membersOf = (view: PenMembershipView) =>
  view.kind === "ready"
    ? new Set(view.snapshot.members.map((member) => member.nodeId))
    : new Set<string>();

/**
 * Points SessionStore's member fence (closed until then) at the watch's newest view, publishes
 * what each view changed and revokes for good what a departed member held. Pen being down closes
 * the fence and revokes nothing, so the same sessions work again when the member list returns.
 */
export const make = Effect.fn("PenMemberSessions.make")(function* () {
  const sessions = yield* SessionStore;
  const watch = yield* PenMembershipWatch;
  // What this follower has acted on. Starts at zero, so a departure before it started counts.
  let handled: PenMembershipMarks = { closed: 0, left: 0 };
  // A departure not yet revoked keeps the fence closed, whatever the newest view says.
  const admission = Effect.gen(function* () {
    const view = yield* watch.current;
    if ((yield* watch.marks).left !== handled.left) return "closed" as const;
    return view.kind === "ready" ? membersOf(view) : ("closed" as const);
  });
  yield* sessions.followPenMembers(admission);

  const revokeUnless = Effect.fn("PenMemberSessions.revokeUnless")(function* (
    members: ReadonlySet<string>,
  ) {
    for (const session of yield* sessions.listPenMemberSessions)
      if (!members.has(session.penMemberNode)) yield* sessions.revoke(session.sessionId);
  });

  const apply = Effect.fn("PenMemberSessions.apply")(function* (view: PenMembershipView) {
    const marks = yield* watch.marks;
    // An outage the newest view hides still closes what was open: announce closed, then reopen.
    if (marks.closed !== handled.closed) yield* sessions.followPenMembers(Effect.succeed("closed"));
    // The fence first: a failed or slow cleanup never leaves a departed member admitted.
    yield* sessions.followPenMembers(admission);
    handled = { ...handled, closed: marks.closed };
    // Leaving the mesh revokes what members held, even if this machine has joined again since.
    const left = marks.left !== handled.left;
    if (view.kind === "unavailable" && !left) return;
    const revoked = yield* revokeUnless(left ? new Set<string>() : membersOf(view)).pipe(
      // A list that could not be read arrives as a defect; it is retried like any failure.
      Effect.sandbox,
      Effect.retry(RETRY),
      // After a departure the fence stays closed until this succeeds, so it keeps trying.
      left ? Effect.retry({ schedule: Schedule.spaced("1 minute") }) : (effect) => effect,
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("pen.memberSessions.cleanup.failed", cause).pipe(Effect.as(false)),
      ),
    );
    // Kept until done, so a later view (or an interrupted cleanup) revokes them again.
    if (!revoked || !left) return;
    handled = { ...handled, left: marks.left };
    yield* sessions.followPenMembers(admission);
  });
  return { apply };
});

const follow = Effect.gen(function* () {
  const { apply } = yield* make();
  const watch = yield* PenMembershipWatch;
  // A newer view interrupts the cleanup of an older one; the fence already reads the newest.
  yield* watch.changes.pipe(
    Stream.switchMap((view) => Stream.fromEffect(apply(view))),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

/** Runs on every server, whatever the Pen settings say: it only ever narrows who may sign in. */
export const layer = Layer.effectDiscard(follow);
