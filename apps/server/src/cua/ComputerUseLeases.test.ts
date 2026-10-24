import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type DesktopCuaReadinessReport,
  type DesktopCuaSafetyReport,
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(
    database,
    ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
  ),
);

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Handoff)));
// The layer is shared across tests, so each test keeps to its own threads.
const thread = ThreadId.make("thread-person");
const other = ThreadId.make("thread-bot");
const appsThread = ThreadId.make("thread-apps");

/** An approved grant for `threadId`, live for an hour. */
const grant = (threadId: ThreadId, id: string, apps?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const handoff: Handoff = {
      handoffId: TurnItemId.make(id),
      kind: "approval",
      title: "Allow computer use?",
      reason: "test",
      requestedBy: {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        path: COMPUTER_USE_GRANT_HANDOFF_PATH,
      },
      target: { environmentId: EnvironmentId.make("env"), path: COMPUTER_USE_GRANT_HANDOFF_PATH },
      dedupeKey: id,
      state: "completed",
      expiresAt: DateTime.add(now, { hours: 1 }),
      createdAt: now,
      actor: { type: "server" },
      ...(apps === undefined ? {} : { apps }),
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${threadId}, 'run', 0, 'human_handoff', 'completed', '2026-01-01',
        ${'{"handoff":' + encodeHandoff(handoff) + "}"})
    `;
    return handoff;
  });

layer("ComputerUseLeases controls", (it) => {
  it.effect(
    "ends a stopped thread's control; its next turn gets a new one and the old id is replaced",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const first = yield* leases.control(thread, Option.none());
        // A second turn within the hour keeps the same control, so its proxy is not respawned.
        assert.equal((yield* leases.control(thread, Option.none())).controlId, first.controlId);
        assert.equal((yield* leases.controlState(thread, first.controlId))._tag, "active");
        // The session list reads the controls each time, so one minted after startup is listed.
        assert.include(
          (yield* leases.sessions).map(({ control }) => control.controlId),
          first.controlId,
        );

        assert.isTrue(yield* leases.stop(thread));
        assert.isFalse(yield* leases.stop(thread));
        assert.deepEqual(yield* leases.controlState(thread, first.controlId), {
          _tag: "ended",
          reason: "stopped",
        });
        const next = yield* leases.control(thread, Option.none());
        assert.notEqual(next.controlId, first.controlId);
        assert.deepEqual(yield* leases.controlState(thread, first.controlId), {
          _tag: "ended",
          reason: "replaced",
        });
      }),
  );

  it.effect("lets an interactive thread control only the apps its live grants name", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const control = yield* leases.control(appsThread, Option.none());
      const apps = leases
        .controlState(appsThread, control.controlId)
        .pipe(Effect.map((state) => (state._tag === "active" ? state.apps : state._tag)));
      assert.deepEqual(yield* apps, []);
      yield* grant(appsThread, "handoff:calc", ["com.apple.calculator"]);
      yield* grant(appsThread, "handoff:notes", ["com.apple.Notes", "com.apple.calculator"]);
      assert.deepEqual(yield* apps, ["com.apple.Notes", "com.apple.calculator"]);
      // A grant without a list is the whole screen.
      yield* grant(appsThread, "handoff:all");
      assert.isUndefined(yield* apps);
    }),
  );

  it.effect("binds an unattended control to its grant and the grant's apps", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* grant(other, "handoff:bot", ["com.apple.calculator"]);
      const lease = yield* leases.active(other);
      assert.isTrue(Option.isSome(lease));
      const control = yield* leases.control(other, lease);
      assert.equal(control.handoffId, "handoff:bot");
      const state = yield* leases.controlState(other, control.controlId);
      assert.deepEqual(state._tag === "active" ? state.apps : state, ["com.apple.calculator"]);
    }),
  );

  it.effect(
    "pauses agents for a person's input only while one holds the screen, and the kill switch ends them all",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        // Someone typing with no agent on the screen pauses nothing to come.
        yield* leases.pause("human_input");
        const mine = yield* leases.control(thread, Option.none());
        assert.equal((yield* leases.controlState(thread, mine.controlId))._tag, "active");

        const bots = yield* leases.control(other, Option.none());
        yield* leases.pause("human_input");
        for (const [id, control] of [
          [thread, mine],
          [other, bots],
        ] as const)
          assert.deepEqual(yield* leases.controlState(id, control.controlId), {
            _tag: "paused",
            reason: "human_input",
          });
        yield* leases.resume;
        assert.equal((yield* leases.controlState(other, bots.controlId))._tag, "active");

        yield* leases.pause("takeover");
        assert.deepEqual([...(yield* leases.stopAll)].sort(), [other, thread].sort());
        assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
          _tag: "ended",
          reason: "stopped_all",
        });
        // With nobody left on the screen the pause is gone too.
        const after = yield* leases.control(thread, Option.none());
        assert.equal((yield* leases.controlState(thread, after.controlId))._tag, "active");
      }),
  );
});

it.effect(
  "tells the desktop to watch from the first live control until the last one ends or expires",
  () =>
    Effect.gen(function* () {
      const sent = yield* Queue.unbounded<boolean>();
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.control(thread, Option.none());
        assert.isTrue(yield* Queue.take(sent));
        // A second agent does not change what the desktop hears.
        yield* leases.control(other, Option.none());
        yield* leases.stop(thread);
        assert.equal(yield* Queue.size(sent), 0);
        yield* leases.stop(other);
        assert.isFalse(yield* Queue.take(sent));

        yield* leases.control(thread, Option.none());
        assert.isTrue(yield* Queue.take(sent));
        // An interactive control lapses after an hour without anyone ending it.
        yield* TestClock.adjust("61 minutes");
        assert.isFalse(yield* Queue.take(sent));
      }).pipe(
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  setCuaWatch: (active) => Queue.offer(sent, active).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);

it.effect("tells the desktop again after a failed write, without waiting for it to reconnect", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<boolean>();
    let failures = 1;
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* leases.control(thread, Option.none());
      assert.isTrue(yield* Queue.take(attempts));
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* Queue.take(attempts));
      // Delivered now: nothing more until something changes.
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.size(attempts), 0);
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({
                setCuaWatch: (active) =>
                  Queue.offer(attempts, active).pipe(
                    Effect.andThen(
                      Effect.suspend(() =>
                        failures-- > 0
                          ? Effect.fail(
                              new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
                                fd: 4,
                                operation: "write",
                                cause: "EAGAIN",
                              }),
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect("after a failed write, a later control is sent even when the desktop last heard it", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<boolean>();
    let failNext = false;
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* leases.control(thread, Option.none());
      assert.isTrue(yield* Queue.take(attempts));
      failNext = true;
      yield* leases.stop(thread);
      assert.isFalse(yield* Queue.take(attempts));
      // The desktop may still be watching or may have stopped; it is told again either way.
      yield* leases.control(thread, Option.none());
      assert.isTrue(yield* Queue.take(attempts));
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({
                setCuaWatch: (active) =>
                  Queue.offer(attempts, active).pipe(
                    Effect.andThen(
                      Effect.suspend(() => {
                        if (!failNext) return Effect.void;
                        failNext = false;
                        return Effect.fail(
                          new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
                            fd: 4,
                            operation: "write",
                            cause: "EAGAIN",
                          }),
                        );
                      }),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect("stops watching when the grant behind the last control is cancelled", () =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<boolean>();
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* grant(other, "handoff:watched");
      yield* leases.control(other, yield* leases.active(other));
      assert.isTrue(yield* Queue.take(sent));
      const proxies = yield* leases.subscribe;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'handoff:watched'`;
      yield* leases.changed;
      yield* PubSub.take(proxies);
      assert.isFalse(yield* Queue.take(sent));
      // Ending it here tells proxies too, so one held on a pause does not wait on.
      yield* PubSub.take(proxies);
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({
                setCuaWatch: (active) => Queue.offer(sent, active).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "follows the helper's reports: what it detects, and a secret field that pauses every agent until it loses focus",
  () =>
    Effect.gen(function* () {
      const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
      // What the receiver accepted; it stores a report before publishing it.
      const accepted = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      const readiness = (
        signals: DesktopCuaReadinessReport["signals"],
      ): DesktopCuaReadinessReport => ({
        version: 1,
        type: "cuaReadiness",
        generation: 1,
        readiness: {
          grants: { accessibility: "granted", screenCapture: "granted" },
          helper: "authenticated",
          capture: "ready",
          tree: "ready",
          input: "background",
          blockers: [],
          reasons: [],
        },
        signals,
      });
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;
        // Nothing reported yet: a host that never says it detects anything detects nothing.
        assert.deepEqual(yield* leases.detection, { humanInput: false, privateMode: false });
        const supported = readiness({ humanInput: "supported", privateMode: "supported" });
        yield* Ref.set(accepted, Option.some(supported));
        yield* Queue.offer(reports, supported);
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.detection, { humanInput: true, privateMode: true });
        // A downgrade counts as soon as the receiver accepts it, before the report is consumed.
        yield* Ref.set(
          accepted,
          Option.some(readiness({ humanInput: "supported", privateMode: "unsupported" })),
        );
        assert.deepEqual(yield* leases.detection, { humanInput: true, privateMode: false });
        yield* Ref.set(accepted, Option.some(supported));

        const control = yield* leases.control(thread, Option.none());
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaPrivateMode",
          active: true,
          target: { pid: 7, windowId: 3 },
        });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "private",
        });
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaPrivateMode",
          active: false,
          target: { pid: 7, windowId: 3 },
        });
        yield* PubSub.take(signals);
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "active");
        // A secret that comes and goes before anyone reads the control still counts as a pause.
        const before = yield* leases.controlState(thread, control.controlId);
        for (const active of [true, false])
          yield* Queue.offer(reports, {
            version: 1,
            type: "cuaPrivateMode",
            active,
            target: { pid: 7, windowId: 3 },
          });
        yield* PubSub.take(signals);
        yield* PubSub.take(signals);
        const after = yield* leases.controlState(thread, control.controlId);
        assert.equal(
          after._tag === "active" && before._tag === "active"
            ? after.interruptions.count - before.interruptions.count
            : -1,
          1,
        );
        assert.deepInclude(after, { interruptions: { count: 2, last: "private" } });
        // A person's input the helper cannot attribute to a device still pauses the agents.
        yield* Queue.offer(reports, { version: 1, type: "cuaHumanInput", source: "unknown" });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
      }).pipe(
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  cuaSafety: Stream.fromQueue(reports),
                  cuaReadiness: Ref.get(accepted),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);
