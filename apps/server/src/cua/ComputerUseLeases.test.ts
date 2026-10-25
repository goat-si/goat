import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import {
  database,
  thread,
  other,
  appsThread,
  turnThread,
  offThread,
  run,
  grant,
} from "./ComputerUseLeases.projection.testkit.ts";

const layer = it.layer(
  Layer.merge(
    database,
    ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
  ),
);
layer("ComputerUseLeases controls", (it) => {
  it.effect("reading the current control never mints or revives a stopped control", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-current-control");
      assert.isTrue(Option.isNone(yield* leases.currentControl(owner)));
      const control = yield* leases.control(owner, Option.none());
      assert.equal(
        Option.getOrThrow(yield* leases.currentControl(owner)).controlId,
        control.controlId,
      );
      yield* leases.stop(owner);
      assert.equal(
        Option.getOrThrow(yield* leases.currentControl(owner)).controlId,
        control.controlId,
      );
      assert.deepEqual(yield* leases.controlState(owner, control.controlId), {
        _tag: "ended",
        reason: "stopped",
      });
    }),
  );
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
    "a turn's control counts as acting once its agent's call reaches it, until the turn ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const owner = ThreadId.make("thread-acted");
          yield* Effect.addFinalizer(() => leases.stop(owner));
          const control = yield* leases.control(owner, Option.none());
          const acted = () =>
            leases.sessions.pipe(
              Effect.map(
                (all) =>
                  all.find((entry) => entry.control.controlId === control.controlId)?.control,
              ),
              Effect.map((listed) => listed?.acted === true),
            );
          assert.isFalse(yield* acted());
          const signals = yield* leases.subscribe;
          // Refused or admitted, the call means this agent wants the screen.
          yield* leases.callReservation(owner, {
            action: "reserve",
            controlId: control.controlId,
            connectionId: "driver:acted",
            callId: "list",
            interruptions: 0,
            idleEpoch: 0,
            name: "list_apps",
            args: {},
          });
          assert.isTrue(yield* acted());
          assert.isAbove(yield* PubSub.remaining(signals), 0);
          yield* run(owner, "run-acted-1", 1, "completed");
          assert.isTrue(yield* leases.turnEnded(owner));
          // Idle keeps the mark, so a card a person stops between turns still shows as stopped.
          assert.isTrue(yield* acted());
          // The next turn reuses the control, and has not asked for the screen yet.
          yield* leases.control(owner, Option.none());
          assert.isFalse(yield* acted());
        }),
      ),
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
        // An idle control has no agent input to pause; it remains active for the next turn.
        yield* leases.pause("takeover");
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
    "an explicit takeover pause holds the screen, and the kill switch ends every agent",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        yield* leases.stopAll;
        // A takeover with no agent on the screen pauses nothing to come.
        yield* leases.pause("takeover");
        const mine = yield* leases.control(thread, Option.none());
        assert.equal((yield* leases.controlState(thread, mine.controlId))._tag, "active");

        const bots = yield* leases.control(other, Option.none());
        yield* leases.pause("takeover");
        for (const [id, control] of [
          [thread, mine],
          [other, bots],
        ] as const)
          assert.deepEqual(yield* leases.controlState(id, control.controlId), {
            _tag: "paused",
            reason: "takeover",
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
        yield* leases.pause("takeover");
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
