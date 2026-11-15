// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const caseInsensitiveTemp = (() => {
  const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-case-"));
  NodeFS.mkdirSync(NodePath.join(probe, "Case"));
  const insensitive = NodeFS.existsSync(NodePath.join(probe, "CASE"));
  NodeFS.rmSync(probe, { recursive: true });
  return insensitive;
})();

describe("ResetCreditCoordinator", () => {
  // Only a case-insensitive volume lets two spellings name one directory.
  it.effect.skipIf(!caseInsensitiveTemp)(
    "differently cased names of one directory are one login directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(NodePath.join(root, "Home"));
        const named = (name: string) =>
          ResetCreditCoordinator.canonicalLoginDirectory(NodePath.join(root, name));
        assert.strictEqual(yield* named("HOME"), yield* named("Home"));
        assert.strictEqual(yield* named("home"), yield* named("Home"));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("re-sends the same idempotency key after a failed attempt, then clears it", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make(0);
      const consume = (key: string) =>
        Effect.gen(function* () {
          yield* Ref.update(keys, (seen) => [...seen, key]);
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (attempt === 1) return yield* Effect.fail("timed out" as const);
          return "reset" as const;
        });

      const first = yield* redeem("acct", consume).pipe(Effect.result);
      assert.isTrue(first._tag === "Failure");
      const second = yield* redeem("acct", consume);
      assert.strictEqual(second, "reset");
      yield* redeem("acct", consume);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 3);
      assert.strictEqual(seen[0], seen[1]);
      assert.notStrictEqual(seen[1], seen[2]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("starts a fresh attempt after a settled failure", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const consume = (key: string) =>
        Ref.update(keys, (seen) => [...seen, key]).pipe(
          Effect.andThen(Effect.fail("cooldown" as const)),
        );
      const isSettled = (error: "cooldown") => error === "cooldown";

      yield* redeem("acct", consume, isSettled).pipe(Effect.result);
      yield* redeem("acct", consume, isSettled).pipe(Effect.result);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 2);
      assert.notStrictEqual(seen[0], seen[1]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("serialises concurrent redemptions on the same account, not per caller", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const inFlight = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          yield* Ref.update(inFlight, (n) => n - 1);
          return "reset" as const;
        });

      const a = yield* redeem("acct", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);

      assert.strictEqual(yield* Ref.get(peak), 1);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("keeps different accounts independent", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const peak = yield* Ref.make(0);
      const inFlight = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          return "reset" as const;
        });
      const a = yield* redeem("acct-a", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct-b", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      assert.strictEqual(yield* Ref.get(peak), 2);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect(
    "a login directory reached through a link shares its account's pending idempotency key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const account = NodePath.join(root, "account");
        const link = NodePath.join(root, "current");
        yield* fs.makeDirectory(account);
        yield* fs.symlink(account, link);
        const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const keys = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (key: string) => Ref.update(keys, (seen) => [...seen, key]);
        yield* redeem(account, (key) =>
          record(key).pipe(Effect.andThen(Effect.fail("timed out" as const))),
        ).pipe(Effect.result);
        yield* redeem(link, (key) => record(key).pipe(Effect.as("reset" as const)));
        const [first, second] = yield* Ref.get(keys);
        assert.strictEqual(second, first);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(ResetCreditCoordinator.layerTest, NodeServices.layer)),
      ),
  );

  it.effect(
    "a login directory created after its first redemption keeps the account's pending key across links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const real = NodePath.join(root, "real");
        const link = NodePath.join(root, "link");
        yield* fs.makeDirectory(real);
        yield* fs.symlink(real, link);
        const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const keys = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (key: string) => Ref.update(keys, (seen) => [...seen, key]);
        yield* redeem(NodePath.join(link, "new"), (key) =>
          record(key).pipe(Effect.andThen(Effect.fail("timed out" as const))),
        ).pipe(Effect.result);
        yield* fs.makeDirectory(NodePath.join(real, "new"));
        yield* redeem(NodePath.join(real, "new"), (key) =>
          record(key).pipe(Effect.as("reset" as const)),
        );
        const [first, second] = yield* Ref.get(keys);
        assert.strictEqual(second, first);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(ResetCreditCoordinator.layerTest, NodeServices.layer)),
      ),
  );

  it.effect(
    "forgets settled accounts and refuses a new account while too many outcomes are uncertain",
    () =>
      Effect.gen(function* () {
        const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const limit = ResetCreditCoordinator.MAX_TRACKED_ACCOUNTS;
        for (let index = 0; index < limit * 2; index += 1) {
          yield* redeem(`/settled/${index}`, () => Effect.succeed("reset" as const));
        }
        for (let index = 0; index < limit; index += 1) {
          yield* redeem(`/uncertain/${index}`, () => Effect.fail("timed out" as const)).pipe(
            Effect.result,
          );
        }
        const refused = yield* redeem("/uncertain/new", () =>
          Effect.succeed("reset" as const),
        ).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "ResetCreditAccountLimitError");
        assert.strictEqual(
          yield* redeem("/uncertain/0", () => Effect.succeed("reset" as const)),
          "reset",
        );
        assert.strictEqual(
          yield* redeem("/uncertain/new", () => Effect.succeed("reset" as const)),
          "reset",
        );
      }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect(
    "a link whose login directory does not exist yet keeps one pending key once it does",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const target = NodePath.join(root, "target");
        const alias = NodePath.join(root, "alias");
        yield* fs.symlink(target, alias);
        const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
        const keys = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (key: string) => Ref.update(keys, (seen) => [...seen, key]);
        yield* redeem(alias, (key) =>
          record(key).pipe(Effect.andThen(Effect.fail("timed out" as const))),
        ).pipe(Effect.result);
        yield* fs.makeDirectory(target);
        yield* redeem(alias, (key) => record(key).pipe(Effect.as("reset" as const)));
        const [first, second] = yield* Ref.get(keys);
        assert.strictEqual(second, first);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(ResetCreditCoordinator.layerTest, NodeServices.layer)),
      ),
  );

  it.effect("re-probes after a reset until the limits are fresh, then gives up", () =>
    Effect.gen(function* () {
      const stale = { usageLimits: { checkedAt: "t0", windows: [] } };
      const run = (freshFrom: number) =>
        Effect.gen(function* () {
          const probes = yield* Ref.make(0);
          const refresh = Ref.updateAndGet(probes, (n) => n + 1).pipe(
            Effect.map((n) =>
              n >= freshFrom ? { usageLimits: { checkedAt: `t${n}`, windows: [] } } : stale,
            ),
          );
          const fiber = yield* ResetCreditCoordinator.refreshAfterRedemption({
            outcome: "reset",
            getSnapshot: Effect.succeed(stale),
            refresh,
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust("1 minute");
          return { confirmed: yield* Fiber.join(fiber), probes: yield* Ref.get(probes) };
        });

      assert.deepStrictEqual(yield* run(3), { confirmed: true, probes: 3 });
      assert.deepStrictEqual(yield* run(Infinity), { confirmed: false, probes: 4 });
    }),
  );
});
