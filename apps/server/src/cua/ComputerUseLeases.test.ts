import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
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
const turnThread = ThreadId.make("thread-turn");
const offThread = ThreadId.make("thread-off");

/** A run of `threadId` in the projection, at `status`. */
const run = (threadId: ThreadId, id: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${id}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')
    `;
  });

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
  it.effect("tells session lists about a control minted for a thread that had none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;
        const minted = ThreadId.make("thread-minted");
        // The layer is shared: a live control left behind would pause later tests' controls.
        yield* Effect.addFinalizer(() => leases.stop(minted));
        yield* leases.control(minted, Option.none());
        // A second thread's session must reach the session list without waiting for another event.
        assert.isAbove(yield* PubSub.remaining(signals), 0);
        yield* PubSub.takeAll(signals);
        // Each later call of the same turn reuses the control and says nothing new.
        yield* leases.control(minted, Option.none());
        assert.equal(yield* PubSub.remaining(signals), 0);
      }),
    ),
  );

  it.effect(
    "refuses competing window mutations and desktop mutations in both admission orders",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const first = ThreadId.make("reservation-first");
        const second = ThreadId.make("reservation-second");
        yield* grant(first, "reservation-first-grant");
        yield* grant(second, "reservation-second-grant");
        const a = yield* leases.control(first, Option.none());
        const b = yield* leases.control(second, Option.none());
        yield* Effect.addFinalizer(() =>
          leases.stop(first).pipe(Effect.andThen(leases.stop(second))),
        );
        const reserve = (owner: ThreadId, controlId: string, callId: string, args: object) =>
          leases.callReservation(owner, {
            action: "reserve",
            controlId,
            connectionId: "driver:1",
            callId,
            interruptions: 0,
            idleEpoch: 0,
            name: "type_text",
            args,
          });
        const window = { pid: 42, window_id: 7, text: "hello" };
        const admitted = yield* reserve(first, a.controlId, "a", window);
        assert.equal(admitted.status, "admitted");
        assert.deepEqual(yield* reserve(second, b.controlId, "b", window), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: first,
        });
        assert.deepEqual(yield* reserve(second, b.controlId, "c", { text: "desktop" }), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: first,
        });
        if (admitted.status !== "admitted" || admitted.reservationId === null)
          return assert.fail("mutation needs an execution reservation");
        yield* leases.callReservation(first, {
          action: "release",
          controlId: a.controlId,
          connectionId: "driver:1",
          reservationId: admitted.reservationId,
        });
        assert.equal(
          (yield* reserve(second, b.controlId, "d", { text: "desktop" })).status,
          "admitted",
        );
        assert.deepEqual(yield* reserve(first, a.controlId, "e", window), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: second,
        });
        yield* leases.callReservation(second, {
          action: "close",
          controlId: b.controlId,
          connectionId: "driver:1",
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "marks a thread's control idle when its last open run ends, and its next turn reuses it",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const first = yield* leases.control(turnThread, Option.none());
        // A queued follow-up keeps the control its proxy already holds.
        yield* run(turnThread, "run-turn-1", 1, "completed");
        yield* run(turnThread, "run-turn-2", 2, "queued");
        assert.isFalse(yield* leases.turnEnded(turnThread));
        assert.equal((yield* leases.controlState(turnThread, first.controlId))._tag, "active");

        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-turn-2'`;
        assert.isTrue(yield* leases.turnEnded(turnThread));
        assert.isFalse(yield* leases.turnEnded(turnThread));
        const listed = () =>
          leases.sessions.pipe(
            Effect.map((all) => all.find(({ control }) => control.controlId === first.controlId)),
          );
        assert.isTrue((yield* listed())?.control.idle);
        // Its proxy keeps the control, so the next turn needs no respawn.
        assert.equal((yield* leases.controlState(turnThread, first.controlId))._tag, "active");
        // A person typing between turns pauses nothing.
        yield* leases.pause("human_input");
        assert.equal((yield* leases.controlState(turnThread, first.controlId))._tag, "active");

        const next = yield* leases.control(turnThread, Option.none());
        assert.equal(next.controlId, first.controlId);
        assert.isUndefined((yield* listed())?.control.idle);
      }),
  );

  it.effect(
    "keeps a control live while a native subagent, on its own child thread, outlives the failed parent run",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const parent = ThreadId.make("thread-parent");
        const control = yield* leases.control(parent, Option.none());
        yield* run(parent, "run-parent-1", 1, "failed");
        const sql = yield* SqlClient.SqlClient;
        // Native subagents report under their child thread, nested ones under their own parent.
        const native = (id: string, owner: string, child: string, status: string) =>
          sql`
            INSERT INTO orchestration_v2_projection_subagents
              (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
            VALUES (${id}, ${owner}, 'node', 'codex', ${child}, 'provider_native', ${status}, '2026-10-24', '{}')
          `;
        yield* native("sub-child", parent, "thread-native-child", "completed");
        yield* native("sub-nested", "thread-native-child", "thread-native-nested", "completed");
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
          VALUES ('turn-nested', 'thread-native-nested', 'native-nested', 'node-nested', 1, 'running', '{}')
        `;
        // A delegated task runs on its own control, so it does not hold this one.
        yield* sql`
          INSERT INTO orchestration_v2_projection_subagents
            (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
          VALUES ('sub-task', ${parent}, 'node', 'codex', 'thread-task', 'app_owned', 'running', '2026-10-24', '{}')
        `;

        yield* leases.settle;
        const listed = () =>
          leases.sessions.pipe(
            Effect.map((all) => all.find((entry) => entry.control.controlId === control.controlId)),
          );
        assert.isUndefined((yield* listed())?.control.idle);

        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'completed' WHERE provider_turn_id = 'turn-nested'`;
        // A child's end is what wakes the check, so it re-reads every control.
        yield* leases.settle;
        assert.isTrue((yield* listed())?.control.idle);
      }),
  );

  it.effect("ends every control when computer use is turned off", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const control = yield* leases.control(offThread, Option.none());
      yield* leases.disable;
      assert.deepEqual(yield* leases.controlState(offThread, control.controlId), {
        _tag: "ended",
        reason: "disabled",
      });
    }),
  );

  it.effect("keeps the app scope a control had once it is stopped", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const scoped = ThreadId.make("thread-scoped");
      const control = yield* leases.control(scoped, Option.none());
      assert.equal((yield* leases.controlState(scoped, control.controlId))._tag, "active");
      yield* leases.stop(scoped);
      const listed = (yield* leases.sessions).find(
        (entry) => entry.control.controlId === control.controlId,
      );
      assert.deepEqual(listed?.control.scope, { apps: [] });
    }),
  );

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

  it.effect(
    "another agent's own input seen by a helper pauses nobody, a person's after it does",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        const mine = yield* leases.control(thread, Option.none());
        const bots = yield* leases.control(other, Option.none());
        const call = (state: "start" | "end", at: number) =>
          leases.agentInput(other, bots.controlId, { call: "7", state, at });
        // Only a live control's own proxy records its calls.
        assert.isFalse(
          yield* leases.agentInput(thread, bots.controlId, { call: "7", state: "start", at: 0 }),
        );
        assert.isTrue(yield* call("start", 1_000));
        // A report dated far from the server's clock is refused and records nothing.
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 10 * 60_000), "refused");
        assert.isFalse(
          yield* leases.agentInput(other, bots.controlId, {
            call: "8",
            state: "start",
            at: 10 * 60_000,
          }),
        );
        // The bot's click, seen by my helper while it runs and just after it answered.
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 1_100), "agents");
        yield* call("end", 1_200);
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 1_600), "agents");
        assert.equal((yield* leases.controlState(thread, mine.controlId))._tag, "active");
        // A person, a moment later.
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 2_000), "paused");
        assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
        yield* leases.resume;
        // A call left open by a control that has ended covers nothing.
        yield* call("start", 5_000);
        yield* leases.stop(other);
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 5_100), "paused");
        assert.deepEqual(yield* leases.controlState(thread, mine.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
      }),
  );

  it.effect(
    "a proxy's report of a person's input pauses every agent, from its live control only",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        const mine = yield* leases.control(thread, Option.none());
        const bots = yield* leases.control(other, Option.none());
        // An old proxy, or another thread's control id, pauses nobody.
        assert.equal(yield* leases.humanInput(thread, "control:old", 0), "refused");
        assert.equal(yield* leases.humanInput(thread, bots.controlId, 0), "refused");
        assert.equal((yield* leases.controlState(other, bots.controlId))._tag, "active");

        assert.equal(yield* leases.humanInput(thread, mine.controlId, 0), "paused");
        for (const [id, control] of [
          [thread, mine],
          [other, bots],
        ] as const)
          assert.deepEqual(yield* leases.controlState(id, control.controlId), {
            _tag: "paused",
            reason: "human_input",
          });
        yield* leases.resume;
        yield* leases.stop(thread);
        // An ended control's proxy can no longer pause the agents left.
        assert.equal(yield* leases.humanInput(thread, mine.controlId, 0), "refused");
        assert.equal((yield* leases.controlState(other, bots.controlId))._tag, "active");
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

        const lapsing = yield* leases.control(thread, Option.none());
        assert.isTrue(yield* Queue.take(sent));
        // An interactive control lapses after an hour without anyone ending it.
        yield* TestClock.adjust("61 minutes");
        assert.isFalse(yield* Queue.take(sent));
        // A lapsed control's proxy can no longer name a window to capture.
        assert.isFalse(yield* leases.setTarget(thread, lapsing.controlId, { pid: 7, windowId: 3 }));
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

it.effect("sends the union of named approvals, updating apps while controls stay active", () =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<{
      active: boolean;
      apps: ReadonlyArray<string> | undefined;
    }>();
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      // A whole-screen approval contributes nothing to the named union.
      yield* grant(other, "handoff:screen");
      yield* leases.control(other, yield* leases.active(other));
      assert.deepEqual(yield* Queue.take(sent), { active: true, apps: [] });
      yield* leases.control(thread, Option.none());
      yield* grant(thread, "handoff:first", ["com.example.notes"]);
      yield* leases.changed;
      assert.deepEqual(yield* Queue.take(sent), { active: true, apps: ["com.example.notes"] });
      yield* grant(thread, "handoff:second", ["com.example.new", "com.example.notes"]);
      yield* leases.changed;
      assert.deepEqual(yield* Queue.take(sent), {
        active: true,
        apps: ["com.example.new", "com.example.notes"],
      });
      yield* leases.stop(thread);
      assert.deepEqual(yield* Queue.take(sent), { active: true, apps: [] });
      yield* leases.stop(other);
      assert.deepEqual(yield* Queue.take(sent), { active: false, apps: [] });
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({
                setCuaWatch: (active, apps) =>
                  Queue.offer(sent, { active, apps }).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "removes expired approved apps while the interactive control keeps watching through a pause",
  () =>
    Effect.gen(function* () {
      const sent = yield* Queue.unbounded<{
        active: boolean;
        apps: ReadonlyArray<string> | undefined;
      }>();
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* grant(thread, "handoff:earlier", ["com.example.notes"]);
        yield* TestClock.adjust("30 minutes");
        const control = yield* leases.control(thread, Option.none());
        assert.deepEqual(yield* Queue.take(sent), { active: true, apps: ["com.example.notes"] });
        yield* leases.pause("human_input");
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "paused");
        yield* TestClock.adjust("31 minutes");
        assert.deepEqual(yield* Queue.take(sent), { active: true, apps: [] });
        yield* leases.resume;
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "active");
        yield* leases.stop(thread);
        assert.deepEqual(yield* Queue.take(sent), { active: false, apps: [] });
      }).pipe(
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  setCuaWatch: (active, apps) =>
                    Queue.offer(sent, { active, apps }).pipe(Effect.asVoid),
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

/** `threadId` in the projection, in `runtimeMode`. */
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

const everyAppLayer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      NodeServices.layer,
      ServerSettings.ServerSettingsService.layerTest({ cuaFullAccessAutoAdmit: true }),
    ),
  ),
);

it.effect(
  "gives a full access thread every app until it leaves full access or the host stops allowing it",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const settings = yield* ServerSettings.ServerSettingsService;
      const auto = ThreadId.make("thread-auto");
      yield* threadIn(auto, "full-access");
      const claim = () =>
        leases
          .everyAppControl(auto, false)
          .pipe(Effect.map((control) => Option.getOrThrow(control)));
      const first = yield* claim();
      const state = yield* leases.controlState(auto, first.controlId);
      assert.equal(state._tag, "active");
      assert.isUndefined(state._tag === "active" ? state.apps : "not active");
      // A turn outside full access gets a control of its own, limited to its grants.
      const scoped = yield* leases.control(auto, Option.none());
      assert.notEqual(scoped.controlId, first.controlId);

      // Leaving full access ends it, with the provider session and its proxy still alive.
      const second = yield* claim();
      yield* threadIn(auto, "auto");
      assert.deepEqual(yield* leases.controlState(auto, second.controlId), {
        _tag: "ended",
        reason: "revoked",
      });

      yield* threadIn(auto, "full-access");
      const third = yield* claim();
      yield* settings.updateSettings({ cuaFullAccessAutoAdmit: false });
      assert.deepEqual(yield* leases.controlState(auto, third.controlId), {
        _tag: "ended",
        reason: "revoked",
      });
      yield* settings.updateSettings({ cuaFullAccessAutoAdmit: true });
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("lists a full access thread's session as soon as it is admitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const signals = yield* leases.subscribe;
      const admitted = ThreadId.make("thread-full-access-listed");
      yield* threadIn(admitted, "full-access");
      yield* Effect.addFinalizer(() => leases.stop(admitted));
      assert.isTrue(Option.isSome(yield* leases.everyAppControl(admitted, false)));
      // Full access admits without a grant; its session still appears in the list at once.
      assert.isAbove(yield* PubSub.remaining(signals), 0);
    }),
  ).pipe(Effect.provide(everyAppLayer)),
);

it.effect("lets one unattended thread at a time hold the screen without a grant", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const first = ThreadId.make("thread-scheduled-1");
    const second = ThreadId.make("thread-scheduled-2");
    const person = ThreadId.make("thread-directed");
    for (const id of [first, second, person]) yield* threadIn(id, "full-access");

    const held = yield* leases.everyAppControl(first, true);
    assert.isTrue(Option.isSome(held));
    assert.isTrue(Option.isNone(yield* leases.everyAppControl(second, true)));
    // Requests and approvals see it as the holder, as they see a grant.
    assert.equal(Option.getOrThrow(yield* leases.holder(second)).threadId, first);
    assert.isTrue(Option.isNone(yield* leases.holder(first)));
    // A person directing a thread can still use the screen meanwhile.
    assert.isTrue(Option.isSome(yield* leases.everyAppControl(person, false)));

    // Once the first one stops, the next can have it; a grant held elsewhere still keeps it out.
    yield* leases.stop(first);
    yield* grant(person, "handoff:person-screen");
    assert.isTrue(Option.isNone(yield* leases.everyAppControl(second, true)));
    yield* leases.stopAll;
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect(
  "ends unattended full access work when a person approved another thread's grant meanwhile",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const scheduled = ThreadId.make("thread-scheduled-race");
      const approved = ThreadId.make("thread-approved-race");
      yield* threadIn(scheduled, "full-access");
      // The approval checked holder() before the claim, so it commits after the claim succeeds.
      const claimed = Option.getOrThrow(yield* leases.everyAppControl(scheduled, true));
      yield* grant(approved, "handoff:approved-race");
      assert.deepEqual(yield* leases.controlState(scheduled, claimed.controlId), {
        _tag: "ended",
        reason: "revoked",
      });
      yield* leases.stopAll;
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect(
  "waits for a grant approval in progress before claiming the screen for unattended work",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const scheduled = ThreadId.make("thread-scheduled-serial");
      const approved = ThreadId.make("thread-approved-serial");
      yield* threadIn(scheduled, "full-access");
      const claiming = yield* leases.serializeAdmission(
        Effect.gen(function* () {
          // The approval found no holder and has not committed yet.
          assert.isTrue(Option.isNone(yield* leases.holder(approved)));
          const claim = yield* leases
            .everyAppControl(scheduled, true)
            .pipe(Effect.forkChild({ startImmediately: true }));
          assert.isUndefined(claim.pollUnsafe());
          yield* grant(approved, "handoff:approved-serial");
          return claim;
        }),
      );
      assert.isTrue(Option.isNone(yield* Fiber.join(claiming)));
      yield* leases.stopAll;
    }).pipe(Effect.provide(everyAppLayer)),
);
