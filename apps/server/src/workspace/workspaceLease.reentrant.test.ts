import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import {
  reuseHeldWorkspaceLease,
  tryWithWorkspaceLease,
  tryWithWorkspaceSubtree,
  type WorkspaceLeaseUnavailableError,
  withWorkspaceLease,
} from "./workspaceLease.ts";

// goat#3674: a restore holds a worktree's lease and runs setup, whose terminal asks for it too.
const free = (cwd: string) =>
  tryWithWorkspaceLease(cwd, Effect.void).pipe(Effect.map(Option.isSome));

it.effect("work run for a folder's holder reuses its lease and gives nothing back", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/basic";
    const innerDone = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        const nested = yield* reuseHeldWorkspaceLease(
          withWorkspaceLease(cwd, Effect.succeed("nested")),
        );
        // A try never waits on the holder, so it stays Busy, as a turn start in the folder must.
        const tried = yield* reuseHeldWorkspaceLease(
          tryWithWorkspaceLease(cwd, Effect.succeed("tried")),
        );
        yield* Deferred.succeed(innerDone, undefined);
        yield* Deferred.await(release);
        return [nested, tried] as const;
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(innerDone);
    // The reentrant section ended while the holder runs: the folder is still held.
    assert.isFalse(yield* free(cwd));
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.join(holder), ["nested", Option.none()]);
    assert.isTrue(yield* free(cwd));
  }),
);

it.effect("reentry is only for the same folder and the same kind of lease, when asked for", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/kind";
    const other = "/lease-reentry/other";
    const otherHeld = yield* Deferred.make<void>();
    const releaseOther = yield* Deferred.make<void>();
    const otherHolder = yield* withWorkspaceLease(
      other,
      Deferred.succeed(otherHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseOther))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(otherHeld);
    const outcomes = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        return {
          subtree: yield* reuseHeldWorkspaceLease(tryWithWorkspaceSubtree(cwd, Effect.void)),
          otherFolder: yield* reuseHeldWorkspaceLease(tryWithWorkspaceLease(other, Effect.void)),
          unmarked: yield* tryWithWorkspaceLease(cwd, Effect.void),
          sameFolder: yield* reuseHeldWorkspaceLease(
            withWorkspaceLease(cwd + "/", Effect.succeed("same folder")),
          ),
        };
      }),
    );
    assert.isTrue(Option.isNone(outcomes.subtree));
    assert.isTrue(Option.isNone(outcomes.otherFolder));
    assert.isTrue(Option.isNone(outcomes.unmarked));
    assert.strictEqual(outcomes.sameFolder, "same folder");
    yield* Deferred.succeed(releaseOther, undefined);
    yield* Fiber.join(otherHolder);
  }),
);

it.effect("only the holder and fibers it forks while holding can enter its lease", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/visibility";
    const events: Array<string> = [];
    const enter = (name: string) =>
      reuseHeldWorkspaceLease(
        withWorkspaceLease(
          cwd,
          Effect.sync(() => events.push(name)),
        ),
      );
    const askEarly = yield* Deferred.make<void>();
    const askLate = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // Forked before the hold, though marked for reuse.
    const early = yield* Deferred.await(askEarly).pipe(
      Effect.andThen(enter("early entered")),
      Effect.forkChild,
    );
    let late: Fiber.Fiber<number, WorkspaceLeaseUnavailableError> | undefined;
    const holder = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        // Forked during the hold, asking only after the holder let go.
        late = yield* Deferred.await(askLate).pipe(
          Effect.andThen(enter("late entered")),
          Effect.forkDetach,
        );
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
        events.push("holder end");
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(held);
    yield* Deferred.succeed(askEarly, undefined);
    // An unrelated fiber marked for reuse.
    const unrelated = yield* enter("unrelated entered").pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(early);
    yield* Fiber.join(unrelated);
    assert.strictEqual(events[0], "holder end");
    assert.sameMembers(events.slice(1), ["early entered", "unrelated entered"]);
    // Another holder takes the folder; the late child's old record does not let it in.
    events.length = 0;
    const secondHeld = yield* Deferred.make<void>();
    const secondRelease = yield* Deferred.make<void>();
    const second = yield* withWorkspaceLease(
      cwd,
      Deferred.succeed(secondHeld, undefined).pipe(
        Effect.andThen(Deferred.await(secondRelease)),
        Effect.andThen(Effect.sync(() => events.push("second end"))),
      ),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(secondHeld);
    yield* Deferred.succeed(askLate, undefined);
    yield* Deferred.succeed(secondRelease, undefined);
    yield* Fiber.join(late ?? (yield* Effect.die("not forked")));
    yield* Fiber.join(second);
    assert.deepEqual(events, ["second end", "late entered"]);
  }),
);

it.effect("two holders of one folder never overlap, reentrant sections included", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/overlap";
    const events: Array<string> = [];
    const gate = yield* Deferred.make<void>();
    const restore = (name: string) =>
      withWorkspaceLease(
        cwd,
        Effect.gen(function* () {
          events.push(name + " start");
          yield* reuseHeldWorkspaceLease(
            withWorkspaceLease(
              cwd,
              Deferred.await(gate).pipe(
                Effect.andThen(Effect.sync(() => events.push(name + " setup"))),
              ),
            ),
          );
          events.push(name + " end");
        }),
      );
    const first = yield* restore("a").pipe(Effect.forkChild);
    const second = yield* restore("b").pipe(Effect.forkChild);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    const order = events.join(", ");
    assert.oneOf(order, [
      "a start, a setup, a end, b start, b setup, b end",
      "b start, b setup, b end, a start, a setup, a end",
    ]);
  }),
);

it.effect("a holder that finishes keeps the folder until its forked reentrant section leaves", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/drain";
    const events: Array<string> = [];
    const entered = yield* Deferred.make<void>();
    const leave = yield* Deferred.make<void>();
    const bodyEnded = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        yield* reuseHeldWorkspaceLease(
          withWorkspaceLease(
            cwd,
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(leave)),
              Effect.ensuring(Effect.sync(() => events.push("child left"))),
            ),
          ),
        ).pipe(Effect.forkDetach);
        yield* Deferred.await(entered);
      }).pipe(Effect.ensuring(Deferred.succeed(bodyEnded, undefined))),
    ).pipe(Effect.andThen(Effect.sync(() => events.push("holder released"))), Effect.forkChild);
    yield* Deferred.await(bodyEnded);
    yield* Deferred.succeed(leave, undefined);
    yield* Fiber.join(holder);
    assert.deepEqual(events, ["child left", "holder released"]);
    assert.isTrue(yield* free(cwd));
  }),
);

it.effect("the holder's release waits for a reentrant section still running, then frees once", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/in-flight";
    const events: Array<string> = [];
    const entered = yield* Deferred.make<void>();
    const leave = yield* Deferred.make<void>();
    const bodyEnded = yield* Deferred.make<void>();
    let child: Fiber.Fiber<void, WorkspaceLeaseUnavailableError> | undefined;
    const holder = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        child = yield* reuseHeldWorkspaceLease(
          withWorkspaceLease(
            cwd,
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(leave)),
              Effect.ensuring(Effect.sync(() => events.push("child left"))),
            ),
          ),
        ).pipe(Effect.forkDetach);
        yield* Deferred.await(entered);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(bodyEnded, undefined))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const interrupted = yield* Fiber.interrupt(holder).pipe(Effect.forkChild);
    yield* Deferred.await(bodyEnded);
    // The next holder gets the folder only after the interrupted holder's child has left.
    const next = yield* withWorkspaceLease(
      cwd,
      Effect.sync(() => events.push("next entered")),
    ).pipe(Effect.forkChild);
    assert.isFalse(yield* free(cwd));
    yield* Deferred.succeed(leave, undefined);
    yield* Fiber.join(child ?? (yield* Effect.die("not forked")));
    yield* Fiber.join(interrupted);
    yield* Fiber.join(next);
    assert.deepEqual(events, ["child left", "next entered"]);
    // Released exactly once: one holder at a time still.
    const again = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const last = yield* withWorkspaceLease(
      cwd,
      Deferred.succeed(again, undefined).pipe(Effect.andThen(Deferred.await(done))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(again);
    assert.isFalse(yield* free(cwd));
    yield* Deferred.succeed(done, undefined);
    yield* Fiber.join(last);
    assert.isTrue(yield* free(cwd));
  }),
);

it.effect("a fiber forked during a hold enters only after the holder ends unless marked", () =>
  Effect.gen(function* () {
    const cwd = "/lease-reentry/opt-in";
    const events: Array<string> = [];
    const child = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        // Runs until it waits; it would enter at once if reentry were not opt-in.
        const forked = yield* withWorkspaceLease(
          cwd,
          Effect.sync(() => events.push("child entered")),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        events.push("holder end");
        return forked;
      }),
    );
    yield* Fiber.join(child);
    assert.deepEqual(events, ["holder end", "child entered"]);
  }),
);
