import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  tryWithWorkspaceLease,
  tryWithWorkspaceSubtree,
  withWorkspaceLease,
} from "./workspaceLease.ts";

it.effect("rejects contention without entering the checkout and admits a later attempt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/contention";
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* withWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const skipped = yield* tryWithWorkspaceLease(
        cwd,
        Effect.die("must not enter a busy checkout"),
      );
      assert.isTrue(Option.isNone(skipped));
      // Different workspaces remain independent while the holder is still busy.
      assert.deepEqual(
        yield* tryWithWorkspaceLease("/lease-test/other", Effect.succeed(1)),
        Option.some(1),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.deepEqual(yield* tryWithWorkspaceLease(cwd, Effect.succeed(2)), Option.some(2));
    }),
  ),
);

it.effect("releases a nonblocking lease after failure and holder interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/interrupt-holder";
      assert.equal(
        yield* tryWithWorkspaceLease(cwd, Effect.fail("failed")).pipe(Effect.flip),
        "failed",
      );
      const held = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(cwd, Effect.void)));
      yield* Fiber.interrupt(holder);
      assert.deepEqual(yield* withWorkspaceLease(cwd, Effect.succeed("released")), "released");
    }),
  ),
);

it.effect("interrupting a blocking waiter does not release the holder's lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/interrupt-waiter";
      const held = yield* Deferred.make<void>();
      const holder = yield* withWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const waiterEntered = yield* Deferred.make<void>();
      const waiter = yield* Deferred.succeed(waiterEntered, undefined).pipe(
        Effect.andThen(withWorkspaceLease(cwd, Effect.die("waiter must not enter"))),
        Effect.forkChild,
      );
      yield* Deferred.await(waiterEntered);
      yield* Fiber.interrupt(waiter);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(cwd, Effect.void)));
      yield* Fiber.interrupt(holder);
      assert.deepEqual(yield* tryWithWorkspaceLease(cwd, Effect.succeed(3)), Option.some(3));
    }),
  ),
);

it.effect(
  "a folder held whole admits no lease inside it but its holder's, and lets waiters in after",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "/lease-test/tree";
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let holderDone = false;
        const holder = yield* tryWithWorkspaceSubtree(
          root,
          Effect.gen(function* () {
            // The removal takes the leases it needs inside the folder it holds.
            assert.equal(yield* withWorkspaceLease(root + "/pkg", Effect.succeed("own")), "own");
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            holderDone = true;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        // A thread bound inside the folder cannot start while it is held.
        assert.isTrue(
          Option.isNone(
            yield* tryWithWorkspaceLease(root + "/packages/app", Effect.die("must not start")),
          ),
        );
        assert.deepEqual(
          yield* tryWithWorkspaceLease("/lease-test/treehouse", Effect.succeed(1)),
          Option.some(1),
        );
        const waiter = yield* withWorkspaceLease(
          root + "/pkg",
          Effect.sync(() => holderDone),
        ).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        assert.deepEqual(yield* Fiber.join(holder), Option.some(undefined));
        assert.isTrue(yield* Fiber.join(waiter));
      }),
    ),
);

it.effect(
  "a folder is not held whole while a lease inside it is held or another hold overlaps",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "/lease-test/busy";
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const worker = yield* withWorkspaceLease(
          root + "/pkg",
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceSubtree(root, Effect.die("must not remove"))),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(worker);
        const nested = yield* tryWithWorkspaceSubtree(
          root,
          tryWithWorkspaceSubtree(root + "/inner", Effect.die("must not overlap")),
        );
        assert.deepEqual(nested, Option.some(Option.none()));
      }),
    ),
);

it.effect("a folder held whole is held through every alias of it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "lease-alias-" }),
      );
      const real = base + "/real";
      yield* fs.makeDirectory(real + "/pkg", { recursive: true });
      yield* fs.symlink(real, base + "/alias");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceSubtree(
        real,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(base + "/alias/pkg", Effect.void)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      // And a lease taken through the alias keeps the real folder from being held whole.
      const leased = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const worker = yield* withWorkspaceLease(
        base + "/alias/pkg",
        Deferred.succeed(leased, undefined).pipe(Effect.andThen(Deferred.await(done))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(leased);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceSubtree(real, Effect.void)));
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(worker);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("interrupting a removal that holds a folder whole releases it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = "/lease-test/interrupted-hold";
      const held = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceSubtree(
        root,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      yield* Fiber.interrupt(holder);
      assert.deepEqual(
        yield* tryWithWorkspaceLease(root + "/pkg", Effect.succeed("started")),
        Option.some("started"),
      );
      assert.deepEqual(yield* tryWithWorkspaceSubtree(root, Effect.succeed(1)), Option.some(1));
    }),
  ),
);
