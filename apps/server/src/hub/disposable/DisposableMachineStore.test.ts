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
import { disposableSwitch } from "./disposableSwitch.ts";

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
      yield* settings.updateSettings(switchOn);
      yield* insert("a1", yield* currentGrant);
      const forward = (fence: number, state: string) =>
        store.commitForward({ attachId: "a1", fence }, advance("a1", state));

      expect(yield* forward(0, "admitted")).toEqual({ committed: true, value: undefined });
      expect(yield* stateOf("a1")).toBe("admitted");
      expect(yield* forward(1, "attaching")).toEqual({ committed: false, reason: "fence_moved" });
      expect(yield* store.commitForward({ attachId: "nope", fence: 0 }, Effect.void)).toEqual({
        committed: false,
        reason: "not_found",
      });
      yield* settings.updateSettings({ hub: { attachDisposableMachines: { cap: 2 } } });
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "grant_changed" });
      // Off, then on again with the same values, is still a new consent.
      yield* settings.updateSettings({ hub: { attachDisposableMachines: { cap: 10 } } });
      yield* settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } });
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "switch_off" });
      yield* settings.updateSettings(switchOn);
      expect(yield* forward(0, "attaching")).toEqual({ committed: false, reason: "grant_changed" });
      yield* insert("a2", yield* currentGrant);
      yield* TestClock.adjust(31 * DAY_MS);
      expect(yield* store.commitForward({ attachId: "a2", fence: 0 }, Effect.void)).toEqual({
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
      yield* settings.updateSettings(switchOn);
      yield* insert("a1", yield* currentGrant);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const change = yield* settings
        .updateSettings(
          { hub: { attachDisposableMachines: { enabled: false } } },
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
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
        .commitForward({ attachId: "a1", fence: 0 }, advance("a1", "admitted"))
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
      yield* settings.updateSettings(switchOn);
      const grant = yield* currentGrant;
      yield* insert("a1", grant);
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const seenAtWrite = Effect.map(settings.getSettings, (current) =>
        disposableSwitch(current.hub, 0),
      );
      const commit = yield* store
        .commitForward(
          { attachId: "a1", fence: 0 },
          Deferred.succeed(inside, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(advance("a1", "admitted")),
            Effect.andThen(seenAtWrite),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      const change = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(
          settings.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } }),
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
      expect(yield* store.commitForward({ attachId: "a1", fence: 0 }, Effect.void)).toEqual({
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
      yield* settings.updateSettings(switchOn);
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
        .commitForward({ attachId: "a1", fence: 0 }, advance("a1", "admitted"))
        .pipe(Effect.forkChild);
      yield* Deferred.await(queued);
      yield* TestClock.adjust(31 * DAY_MS);
      yield* Deferred.succeed(releaseTransaction, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(commit)).toEqual({ committed: false, reason: "switch_expired" });
      expect(yield* stateOf("a1")).toBe("invited");
    }),
  ),
);
