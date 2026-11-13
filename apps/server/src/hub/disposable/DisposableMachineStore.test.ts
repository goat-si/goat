import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as Settings from "../../serverSettings.ts";
import * as Store from "./DisposableMachineStore.ts";
import { disposableSwitch, withPersonConsent } from "./disposableSwitch.ts";

const T0 = "1970-01-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

const insert = (attachId: string, grant: string, overrides: Record<string, unknown> = {}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`INSERT INTO disposable_machines ${sql.insert({
        attach_id: attachId,
        provisioner_json: JSON.stringify({ kind: "thread", threadId: "thread-1" }),
        delegation_json: "{}",
        name: "cc-11",
        expected_sign_pub: "sign-" + attachId,
        expected_noise_pub: "noise-" + attachId,
        node_id: "node-" + attachId,
        grant_id: grant,
        state: "invited",
        created_at: T0,
        state_since: T0,
        updated_at: T0,
        ...overrides,
      })}`,
  );
const stateOf = (attachId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      readonly state: string;
    }>`SELECT state FROM disposable_machines WHERE attach_id = ${attachId}`.pipe(
      Effect.map((rows) => rows[0]?.state),
    ),
  );
const advance = (attachId: string, state: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE disposable_machines SET state = ${state} WHERE attach_id = ${attachId}`,
  ).pipe(Effect.asVoid);

const switchOn = { hub: { enabled: true, attachDisposableMachines: { enabled: true } } };
const currentGrant = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const gate = disposableSwitch((yield* settings.getSettings).hub, 0);
  if (!gate.open) return yield* Effect.die("switch closed");
  return gate.grant;
});

const world = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provideServiceEffect(Store.DisposableMachineStore, Store.make),
    Effect.provide(
      Layer.merge(
        Settings.ServerSettingsService.layerTest(),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );

// A row the hub nodes snapshot could not send must fail the read here, where it reads as kept.
it.effect("a row the wire cannot carry makes the table unreadable, never the hub node list", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const store = yield* Store.DisposableMachineStore;
      yield* insert("a1", "g");
      expect(yield* store.records).toHaveLength(1);
      for (const overrides of [
        { conflicts_json: JSON.stringify(Array.from({ length: 17 }, (_, i) => "c" + i)) },
        { state: "s".repeat(41) },
        { state: " " },
      ]) {
        yield* insert("bad", "g", {
          ...overrides,
          expected_sign_pub: "sb",
          expected_noise_pub: "nb",
          node_id: "nb",
        });
        expect(yield* store.records.pipe(Effect.flip), JSON.stringify(overrides)).toBeInstanceOf(
          Store.DisposableStoreError,
        );
        expect(yield* store.recordsOrKept).toEqual([]);
        yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`DELETE FROM disposable_machines WHERE attach_id = 'bad'`,
        );
      }
    }),
  ),
);

it.effect("an unreadable table reads as no records, so every machine is kept", () =>
  world(
    Effect.gen(function* () {
      const store = yield* Store.DisposableMachineStore;
      // Before the migration there is no table at all.
      expect(yield* store.records.pipe(Effect.flip)).toBeInstanceOf(Store.DisposableStoreError);
      expect(yield* store.recordsOrKept).toEqual([]);
      yield* runMigrations({ toMigrationInclusive: 145 });
      yield* insert("a1", "g", { provisioner_json: "{not json" });
      expect(yield* store.records.pipe(Effect.flip)).toBeInstanceOf(Store.DisposableStoreError);
      expect(yield* store.recordsOrKept).toEqual([]);
    }),
  ),
);

it.effect("a forward commit runs only under the switch's grant and the record's fence", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* insert("a1", yield* currentGrant);
      const forward = (fence: number, state: string) =>
        store.commitForward({ attachId: "a1", fence }, () => advance("a1", state));

      expect(yield* forward(0, "admitted")).toEqual({ committed: true, value: undefined });
      expect(yield* stateOf("a1")).toBe("admitted");
      // The commit advanced the fence, so a second step that read fence 0 is refused.
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "fence_moved" });
      expect(yield* store.commitForward({ attachId: "nope", fence: 0 }, () => Effect.void)).toEqual(
        {
          committed: false,
          reason: "not_found",
        },
      );
      yield* withPersonConsent(
        settings.updateSettings({ hub: { attachDisposableMachines: { cap: 2 } } }),
      );
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "grant_changed" });
      // Off, then on again with the same values, is still a new consent.
      yield* withPersonConsent(
        settings.updateSettings({ hub: { attachDisposableMachines: { cap: 10 } } }),
      );
      yield* withPersonConsent(
        settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } }),
      );
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "switch_off" });
      yield* withPersonConsent(settings.updateSettings(switchOn));
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "grant_changed" });
      yield* insert("a2", yield* currentGrant);
      yield* TestClock.adjust(31 * DAY_MS);
      expect(yield* store.commitForward({ attachId: "a2", fence: 0 }, () => Effect.void)).toEqual({
        committed: false,
        reason: "switch_expired",
      });
      expect(yield* stateOf("a1")).toBe("admitted");
    }),
  ),
);

it.effect("a forward commit queued behind a settings change sees that change", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* insert("a1", yield* currentGrant);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const change = yield* withPersonConsent(
        settings.updateSettings(
          { hub: { attachDisposableMachines: { enabled: false } } },
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const observed = Settings.ServerSettingsService.of({
        ...settings,
        withSettingsSnapshot: (use) =>
          Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(settings.withSettingsSnapshot(use)),
          ),
      });
      const store = yield* Store.make.pipe(
        Effect.provideService(Settings.ServerSettingsService, observed),
      );
      const commit = yield* store
        .commitForward({ attachId: "a1", fence: 0 }, () => advance("a1", "admitted"))
        .pipe(Effect.forkChild);
      yield* Deferred.await(queued);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(change);
      expect(yield* Fiber.join(commit)).toEqual({ committed: false, reason: "switch_off" });
      expect(yield* stateOf("a1")).toBe("invited");
    }),
  ),
);

it.effect("a switch-off during a forward commit lets that commit finish and refuses the next", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      const grant = yield* currentGrant;
      yield* insert("a1", grant);
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const commit = yield* store
        .commitForward({ attachId: "a1", fence: 0 }, (current) =>
          Deferred.succeed(inside, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(advance("a1", "admitted")),
            Effect.as(disposableSwitch(current.hub, 0)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      const change = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          withPersonConsent(
            settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(queued);
      yield* Deferred.succeed(release, undefined);
      // The write ran wholly under the grant it was admitted with.
      expect(yield* Fiber.join(commit)).toEqual({
        committed: true,
        value: { open: true, grant },
      });
      yield* Fiber.join(change);
      expect(yield* stateOf("a1")).toBe("admitted");
      expect(yield* store.commitForward({ attachId: "a1", fence: 0 }, () => Effect.void)).toEqual({
        committed: false,
        reason: "switch_off",
      });
    }),
  ),
);

it.effect(
  "more open records than the read can show reads as unreadable, never as a partial list",
  () =>
    world(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 145 });
        const store = yield* Store.DisposableMachineStore;
        // Records in a final state are not read, whatever their number.
        for (let index = 0; index < 1000; index += 1)
          yield* insert("open-" + String(index).padStart(4, "0"), "g");
        yield* insert("final-1", "g", { state: "purged", final_at: T0 });
        expect(yield* store.records).toHaveLength(1000);
        // The 1001st open record, sharing a pin with the first, must not be dropped silently.
        yield* insert("open-1000", "g", { sshd_pin: "SHA256:shared" });
        expect(yield* store.records.pipe(Effect.flip)).toBeInstanceOf(Store.DisposableStoreError);
        expect(yield* store.recordsOrKept).toEqual([]);
      }),
    ),
);

it.effect("a forward commit that waits for the database past the switch's expiry is refused", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* Settings.ServerSettingsService;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      // An expiry inside the commit's bound, so the wait outlasts the switch and not the bound.
      yield* withPersonConsent(
        settings.updateSettings({
          hub: { attachDisposableMachines: { expiresAt: "1970-01-01T00:00:10.000Z" } },
        }),
      );
      yield* insert("a1", yield* currentGrant);
      const inTransaction = yield* Deferred.make<void>();
      const releaseTransaction = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          Deferred.succeed(inTransaction, undefined).pipe(
            Effect.andThen(Deferred.await(releaseTransaction)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inTransaction);
      const queued = yield* Deferred.make<void>();
      const observed = Settings.ServerSettingsService.of({
        ...settings,
        withSettingsSnapshot: (use) =>
          Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(settings.withSettingsSnapshot(use)),
          ),
      });
      const store = yield* Store.make.pipe(
        Effect.provideService(Settings.ServerSettingsService, observed),
      );
      const commit = yield* store
        .commitForward({ attachId: "a1", fence: 0 }, () => advance("a1", "admitted"))
        .pipe(Effect.forkChild);
      yield* Deferred.await(queued);
      yield* TestClock.adjust(11_000);
      yield* Deferred.succeed(releaseTransaction, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(commit)).toEqual({ committed: false, reason: "switch_expired" });
      expect(yield* stateOf("a1")).toBe("invited");
    }),
  ),
);

it.effect("two steps that read the same fence: the first commits, the second is refused", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* insert("a1", yield* currentGrant);
      const step = (state: string) =>
        store.commitForward({ attachId: "a1", fence: 0 }, () => advance("a1", state));
      expect(yield* step("admitted")).toEqual({ committed: true, value: undefined });
      expect(yield* step("attaching")).toEqual({ committed: false, reason: "fence_moved" });
      expect(yield* stateOf("a1")).toBe("admitted");
    }),
  ),
);

it.effect("a write that stalls gives up the settings lock at the bound and changes nothing", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* insert("a1", yield* currentGrant);
      const inside = yield* Deferred.make<void>();
      const commit = yield* store
        .commitForward({ attachId: "a1", fence: 0 }, () =>
          advance("a1", "admitted").pipe(
            Effect.andThen(Deferred.succeed(inside, undefined)),
            Effect.andThen(Effect.never),
          ),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(inside);
      yield* TestClock.adjust(15_000);
      expect(yield* Fiber.join(commit)).toBeInstanceOf(Store.DisposableStoreError);
      expect(yield* stateOf("a1")).toBe("invited");
      // Settings writers are not left waiting.
      yield* withPersonConsent(
        settings.updateSettings({ hub: { attachDisposableMachines: { cap: 3 } } }),
      );
    }),
  ),
);

it.effect("a write's own failure reaches the caller as itself, never as unreadable records", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* insert("a1", yield* currentGrant);
      yield* insert("a2", "g", { mint_id: "m-1" });
      const sql = yield* SqlClient.SqlClient;
      const failure = yield* store
        .commitForward(
          { attachId: "a1", fence: 0 },
          () => sql`UPDATE disposable_machines SET mint_id = 'm-1' WHERE attach_id = 'a1'`,
        )
        .pipe(Effect.flip);
      expect(failure).not.toBeInstanceOf(Store.DisposableStoreError);
      expect(yield* stateOf("a1")).toBe("invited");
    }),
  ),
);

it.effect("a record cannot enter a final state without final_at", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      expect(yield* insert("a1", "g", { state: "failed" }).pipe(Effect.isFailure)).toBe(true);
      yield* insert("a2", "g", { state: "failed", final_at: T0 });
      const store = yield* Store.DisposableMachineStore;
      expect(yield* store.records).toEqual([]);
    }),
  ),
);

it.effect("a write admitted before the switch expires but finishing after it is rolled back", () =>
  world(
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 145 });
      const settings = yield* Settings.ServerSettingsService;
      const store = yield* Store.DisposableMachineStore;
      yield* withPersonConsent(settings.updateSettings(switchOn));
      yield* withPersonConsent(
        settings.updateSettings({
          hub: { attachDisposableMachines: { expiresAt: "1970-01-01T00:00:10.000Z" } },
        }),
      );
      yield* insert("a1", yield* currentGrant);
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commit = yield* store
        .commitForward({ attachId: "a1", fence: 0 }, () =>
          advance("a1", "admitted").pipe(
            Effect.andThen(Deferred.succeed(inside, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      yield* TestClock.adjust(11_000);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(commit)).toEqual({ committed: false, reason: "switch_expired" });
      expect(yield* stateOf("a1")).toBe("invited");
    }),
  ),
);
