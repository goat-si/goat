import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as CuaDriver from "./CuaDriver.ts";
import { database, grant } from "./ComputerUseLeases.projection.testkit.ts";

const threadIn = (threadId: ThreadId, runtimeMode: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', 'thread', 'codex', ${runtimeMode}, 'default',
        '2026-01-01', '2026-01-01', '{}')
      ON CONFLICT (thread_id) DO UPDATE SET runtime_mode = excluded.runtime_mode
    `;
  });

it.effect("person and grant controls do not read the terminal catalog", () => {
  let reads = 0;
  return Effect.gen(function* () {
    yield* runMigrations();
    yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
      cuaStrictInputGuards: true,
    });
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const person = ThreadId.make("thread-catalog-person");
    const granted = ThreadId.make("thread-catalog-grant");
    yield* threadIn(person, "full-access");
    const personControl = Option.getOrThrow(yield* leases.everyAppControl(person, false));
    yield* grant(granted, "handoff:catalog-grant", ["com.example.Editor"]);
    const grantControl = Option.getOrThrow(
      yield* leases.control(granted, yield* leases.active(granted)),
    );
    for (const [owner, control, pid] of [
      [person, personControl, 42],
      [granted, grantControl, 43],
    ] as const) {
      const result = yield* leases.callReservation(owner, {
        action: "reserve",
        controlId: control.controlId,
        connectionId: "connection",
        callId: "call",
        interruptions: 0,
        idleEpoch: 0,
        name: "click",
        args: { pid, window_id: 7 },
        app: pid === 42 ? "com.example.Other" : "com.example.Editor",
      });
      assert.equal(result.status, "admitted");
    }
    assert.equal(reads, 0);
  }).pipe(
    Effect.provide(
      ComputerUseLeases.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            database,
            NodeServices.layer,
            ServerSettings.ServerSettingsService.layerTest({
              enableCua: true,
              cuaFullAccessAutoAdmit: false,
            }),
            Layer.mock(CuaDriver.CuaDriver)({
              availableAppCatalog: Effect.sync(() => {
                reads++;
                return Option.none();
              }),
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("a pending catalog listing does not hold the call admission permit", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        cuaStrictInputGuards: true,
      });
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const remote = ThreadId.make("thread-catalog-pending");
      const person = ThreadId.make("thread-catalog-concurrent");
      yield* threadIn(remote, "full-access");
      yield* threadIn(person, "full-access");
      const remoteControl = Option.getOrThrow(
        yield* leases.everyAppControl(remote, false, { nonPerson: true }),
      );
      const personControl = Option.getOrThrow(yield* leases.everyAppControl(person, false));
      const call = (owner: ThreadId, controlId: string, pid: number) =>
        leases.callReservation(owner, {
          action: "reserve",
          controlId,
          connectionId: "connection",
          callId: "call",
          interruptions: 0,
          idleEpoch: 0,
          name: "click",
          args: { pid, window_id: 7 },
          app: `com.example.App${pid}`,
        });
      const pending = yield* call(remote, remoteControl.controlId, 42).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      assert.equal((yield* call(person, personControl.controlId, 43)).status, "admitted");
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(pending)).status, "admitted");
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              ServerSettings.ServerSettingsService.layerTest({
                enableCua: true,
                cuaFullAccessAutoAdmit: false,
              }),
              Layer.mock(CuaDriver.CuaDriver)({
                availableAppCatalog: Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some([])),
                ),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect("admission observes a source catalog refresh five seconds after it was primed", () =>
  Effect.gen(function* () {
    let terminal = false;
    const [source] = yield* Effect.cachedInvalidateWithTTL(
      Effect.sync(() =>
        Option.some([{ id: "org.example.shell", name: terminal ? "GNOME Terminal" : "Shell" }]),
      ),
      "5 seconds",
    );
    yield* Effect.gen(function* () {
      yield* runMigrations();
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        cuaStrictInputGuards: true,
      });
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-staggered-catalog");
      yield* threadIn(owner, "full-access");
      const control = Option.getOrThrow(
        yield* leases.everyAppControl(owner, false, { nonPerson: true }),
      );
      const call = (callId: string) =>
        leases.callReservation(owner, {
          action: "reserve",
          controlId: control.controlId,
          connectionId: "connection",
          callId,
          interruptions: 0,
          idleEpoch: 0,
          name: "click",
          args: { pid: 42, window_id: 7 },
          app: "org.example.shell",
        });
      yield* source;
      yield* TestClock.adjust("4900 millis");
      assert.equal((yield* call("first")).status, "admitted");
      terminal = true;
      yield* TestClock.adjust("200 millis");
      assert.deepInclude(yield* call("second"), { status: "refused", detail: "app_not_allowed" });
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              ServerSettings.ServerSettingsService.layerTest({
                enableCua: true,
                cuaFullAccessAutoAdmit: false,
              }),
              Layer.mock(CuaDriver.CuaDriver)({ availableAppCatalog: source }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect.each([
  { available: false, strict: true, expected: "refused", reads: 1 },
  { available: true, strict: true, expected: "admitted", reads: 1 },
  { available: false, strict: false, expected: "admitted", reads: 0 },
] as const)(
  "catalog availability $available with strict guards $strict controls admission",
  ({ available, strict, expected, reads }) => {
    let count = 0;
    const layer = ComputerUseLeases.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          database,
          NodeServices.layer,
          ServerSettings.ServerSettingsService.layerTest({
            enableCua: true,
            cuaFullAccessAutoAdmit: false,
          }),
          Layer.mock(CuaDriver.CuaDriver)({
            appCatalog: Effect.sync(() => {
              count++;
              return [];
            }),
            availableAppCatalog: Effect.sync(() => {
              count++;
              return available ? Option.some([]) : Option.none();
            }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* runMigrations();
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        cuaStrictInputGuards: strict,
      });
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-catalog-availability");
      yield* threadIn(owner, "full-access");
      const control = Option.getOrThrow(
        yield* leases.everyAppControl(owner, false, { nonPerson: true }),
      );
      const result = yield* leases.callReservation(owner, {
        action: "reserve",
        controlId: control.controlId,
        connectionId: "connection",
        callId: "one",
        interruptions: 0,
        idleEpoch: 0,
        name: "click",
        args: { pid: 42, window_id: 7 },
        app: "org.example.editor",
      });
      assert.equal(result.status, expected);
      if (result.status === "refused") assert.equal(result.detail, "reconnecting");
      assert.equal(count, reads);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("non-person call admission shares a catalog listing until its short expiry", () => {
  let listings = 0;
  const layer = ComputerUseLeases.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        NodeServices.layer,
        ServerSettings.ServerSettingsService.layerTest({
          enableCua: true,
          cuaFullAccessAutoAdmit: false,
        }),
        Layer.unwrap(
          Effect.cachedInvalidateWithTTL(
            Effect.sync(() => {
              listings++;
              return Option.some([{ id: "org.example.shell", name: "GNOME Terminal" }]);
            }),
            "5 seconds",
          ).pipe(
            Effect.map(([source]) =>
              Layer.mock(CuaDriver.CuaDriver)({ availableAppCatalog: source }),
            ),
          ),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* runMigrations();
    yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
      cuaStrictInputGuards: true,
    });
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-terminal-catalog-cache");
    yield* threadIn(owner, "full-access");
    const control = Option.getOrThrow(
      yield* leases.everyAppControl(owner, false, { nonPerson: true }),
    );
    const call = (callId: string) =>
      leases.callReservation(owner, {
        action: "reserve",
        controlId: control.controlId,
        connectionId: "connection",
        callId,
        interruptions: 0,
        idleEpoch: 0,
        name: "click",
        args: { pid: 42, window_id: 7 },
        app: "org.example.shell",
        safetyApps: ["org.example.shell", "Shell"],
      });
    assert.deepInclude(yield* call("one"), { status: "refused", detail: "app_not_allowed" });
    assert.deepInclude(yield* call("two"), { status: "refused", detail: "app_not_allowed" });
    assert.equal(listings, 1);
    yield* TestClock.adjust("6 seconds");
    assert.deepInclude(yield* call("three"), { status: "refused", detail: "app_not_allowed" });
    assert.equal(listings, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("server admission refuses a terminal known only through its catalog alias", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
      cuaStrictInputGuards: true,
    });
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-terminal-catalog");
    yield* threadIn(owner, "full-access");
    const control = Option.getOrThrow(
      yield* leases.everyAppControl(owner, false, { nonPerson: true }),
    );
    const result = yield* leases.callReservation(owner, {
      action: "reserve",
      controlId: control.controlId,
      connectionId: "connection",
      callId: "opaque",
      interruptions: 0,
      idleEpoch: 0,
      name: "click",
      args: { pid: 42, window_id: 7 },
      app: "org.example.shell",
      safetyApps: ["org.example.shell", "Shell"],
    });
    assert.deepInclude(result, { status: "refused", detail: "app_not_allowed" });
  }).pipe(
    Effect.provide(
      ComputerUseLeases.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            database,
            NodeServices.layer,
            ServerSettings.ServerSettingsService.layerTest({
              enableCua: true,
              cuaFullAccessAutoAdmit: false,
            }),
            Layer.mock(CuaDriver.CuaDriver)({
              availableAppCatalog: Effect.succeedSome([
                { id: "org.example.shell", name: "GNOME Terminal" },
              ]),
            }),
          ),
        ),
      ),
    ),
  ),
);
