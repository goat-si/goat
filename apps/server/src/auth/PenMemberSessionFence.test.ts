import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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
    yield* fence.follow(Effect.succeed(new Set([node])));
    expect(yield* fence.denied(id)).toBe(false);
    yield* fence.follow(Effect.succeed("closed"));
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
    yield* fence.follow(Effect.succeed(new Set([node])));
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
      .follow(Effect.succeed(new Set([node])))
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(entered);
    expect(yield* fence.denied(id)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(update);
  }).pipe(Effect.scoped),
);

it.effect("checks read the newest member list, before any notification is published", () =>
  Effect.gen(function* () {
    const id = AuthSessionId.make("member");
    const node = "a".repeat(26);
    let members: Fence.PenAdmission = new Set([node]);
    const fence = yield* Fence.make(
      [{ sessionId: id, subject: `pen-member:${node}`, penMemberNode: node }],
      () => Effect.void,
      () => Effect.void,
    );
    yield* fence.follow(Effect.sync(() => members));
    expect(yield* fence.denied(id)).toBe(false);
    members = "closed";
    expect(yield* fence.denied(id)).toBe(true);
  }),
);

it.effect("drops expired member sessions, and refuses a new one past the limit", () =>
  Effect.gen(function* () {
    const node = "a".repeat(26);
    const now = yield* DateTime.now;
    const row = (name: string, minutes: number) => ({
      sessionId: AuthSessionId.make(name),
      subject: `pen-member:${node}`,
      penMemberNode: node,
      expiresAt: DateTime.add(now, { minutes }),
    });
    const fence = yield* Fence.make(
      [row("soon", 1), row("later", 60)],
      () => Effect.void,
      () => Effect.void,
      {
        maxTracked: 2,
      },
    );
    yield* fence.follow(Effect.succeed(new Set([node])));
    // Untracked is never admitted: the third member session is refused while both are live.
    expect(yield* Effect.exit(fence.guard(row("third", 60)))).toMatchObject({ _tag: "Failure" });
    expect(fence.tracked()).toBe(2);
    yield* TestClock.adjust("2 minutes");
    yield* fence.guard(row("third", 60));
    expect(fence.tracked()).toBe(2);
    expect(yield* fence.denied(AuthSessionId.make("third"))).toBe(false);
  }),
);

it.effect(
  "loads at most the limit at start, and a member session with no place is refused before it is written",
  () =>
    Effect.gen(function* () {
      const node = "a".repeat(26);
      const row = (name: string) => ({
        sessionId: AuthSessionId.make(name),
        subject: `pen-member:${node}`,
        penMemberNode: node,
      });
      const fence = yield* Fence.make(
        [row("a"), row("b"), row("c")],
        () => Effect.void,
        () => Effect.void,
        {
          maxTracked: 2,
        },
      );
      yield* fence.follow(Effect.succeed(new Set([node])));
      expect(fence.tracked()).toBe(2);
      // Past the limit at start: untracked, so denied.
      expect(yield* Effect.exit(fence.guard(row("c")))).toMatchObject({ _tag: "Failure" });
      const now = yield* DateTime.now;
      const writes: Array<string> = [];
      const issued = { ...row("d"), expiresAt: DateTime.add(now, { hours: 1 }) };
      const refused = yield* Effect.exit(
        fence.issuing(
          issued,
          { penMemberNode: node },
          Effect.sync(() => writes.push("d")),
        ),
      );
      expect(refused._tag).toBe("Failure");
      expect(writes).toEqual([]);
      // A failed write gives its place back.
      yield* fence.forget(AuthSessionId.make("b"));
      yield* Effect.exit(fence.issuing(issued, { penMemberNode: node }, Effect.fail("disk full")));
      expect(fence.tracked()).toBe(1);
    }),
);
