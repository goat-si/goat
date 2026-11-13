import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Fence from "./PenMemberSessionFence.ts";

it.effect("only admits an exact valid marker and suspends when the view closes", () =>
  Effect.gen(function* () {
    const id = AuthSessionId.make("member");
    const node = "a".repeat(26);
    const changes: Array<string> = [];
    const fence = yield* Fence.make(
      [{ sessionId: id, subject: `pen-member:${node}`, penMemberNode: node }],
      (sessionId) =>
        Effect.sync(() => {
          changes.push(`suspend:${sessionId}`);
        }),
      (sessionId) =>
        Effect.sync(() => {
          changes.push(`resume:${sessionId}`);
        }),
    );
    expect(yield* fence.denied(id)).toBe(true);
    yield* fence.setAdmitted(new Set([node]));
    expect(yield* fence.denied(id)).toBe(false);
    yield* fence.setAdmitted("closed");
    expect(changes).toEqual(["resume:member", "suspend:member"]);
    yield* fence.observe({
      sessionId: AuthSessionId.make("forged"),
      subject: `pen-member:${node}`,
      penMemberNode: null,
    });
    yield* fence.observe({
      sessionId: AuthSessionId.make("ordinary"),
      subject: "browser",
      penMemberNode: null,
    });
    yield* fence.setAdmitted(new Set([node]));
    expect(yield* fence.denied(AuthSessionId.make("forged"))).toBe(true);
    expect(yield* fence.denied(AuthSessionId.make("ordinary"))).toBe(false);
    for (const row of [
      {
        sessionId: AuthSessionId.make("malformed"),
        subject: "pen-member:bad",
        penMemberNode: "bad",
      },
      { sessionId: AuthSessionId.make("mismatch"), subject: "browser", penMemberNode: node },
      {
        sessionId: AuthSessionId.make("other"),
        subject: `pen-member:${"b".repeat(26)}`,
        penMemberNode: "b".repeat(26),
      },
    ]) {
      yield* fence.observe(row);
      expect(yield* fence.denied(row.sessionId)).toBe(true);
    }
  }),
);

it.effect("scope checks do not wait for an in-flight admission notification", () =>
  Effect.gen(function* () {
    const id = AuthSessionId.make("member");
    const node = "a".repeat(26);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fence = yield* Fence.make(
      [{ sessionId: id, subject: `pen-member:${node}`, penMemberNode: node }],
      () => Effect.void,
      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const update = yield* fence
      .setAdmitted(new Set([node]))
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(entered);
    expect(yield* fence.denied(id)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(update);
  }).pipe(Effect.scoped),
);
