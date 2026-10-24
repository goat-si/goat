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

  it.effect(
    "lists a turn the desktop blocked while it runs, until a driver starts for it or the turn ends (#1399)",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const block = {
          reason: "permissionsNotGranted",
          missing: ["screenRecording"],
          holder: "helper",
        } as const;
        const sql = yield* SqlClient.SqlClient;
        const blocked = ThreadId.make("thread-blocked");
        yield* run(blocked, "run-blocked-1", 1, "running");
        yield* leases.blocked(blocked, block);
        assert.deepEqual(yield* leases.blockedTurns, [{ threadId: blocked, block }]);
        // Still running: the turn stays listed.
        yield* leases.settle;
        assert.lengthOf(yield* leases.blockedTurns, 1);
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-blocked-1'`;
        yield* leases.settle;
        assert.deepEqual(yield* leases.blockedTurns, []);

        // A later turn that gets a driver is no longer blocked.
        const granted = ThreadId.make("thread-granted");
        yield* leases.blocked(granted, block);
        yield* leases.control(granted, Option.none());
        assert.deepEqual(yield* leases.blockedTurns, []);
      }),
  );

  it.effect("wakes the session list whenever a blocked turn is listed or cleared (#1399)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const block = {
          reason: "permissionsNotGranted",
          missing: ["accessibility"],
          holder: "helper",
        } as const;
        const subscription = yield* leases.subscribe;
        const woke = Effect.gen(function* () {
          const count = yield* PubSub.remaining(subscription);
          if (count > 0) yield* PubSub.takeAll(subscription);
          return count > 0;
        });
        const first = ThreadId.make("thread-blocked-first");
        yield* leases.blocked(first, block);
        assert.isTrue(yield* woke);
        // Its first control clears it.
        yield* leases.control(first, Option.none());
        assert.isTrue(yield* woke);
        yield* leases.stop(first);
        yield* woke;
        // Turning computer use off with only a blocked turn listed clears it too.
        yield* leases.blocked(ThreadId.make("thread-blocked-off"), block);
        yield* woke;
        yield* leases.disable;
        assert.isTrue(yield* woke);
        assert.deepEqual(yield* leases.blockedTurns, []);
      }),
    ),
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
        assert.deepEqual(yield* leases.detection, {
          humanInput: false,
          privateMode: false,
          frames: false,
        });
        const supported = readiness({ humanInput: "supported", privateMode: "supported" });
        yield* Ref.set(accepted, Option.some(supported));
        yield* Queue.offer(reports, supported);
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.detection, {
          humanInput: true,
          privateMode: true,
          frames: false,
        });
        // A downgrade counts as soon as the receiver accepts it, before the report is consumed.
        yield* Ref.set(
          accepted,
          Option.some(readiness({ humanInput: "supported", privateMode: "unsupported" })),
        );
        assert.deepEqual(yield* leases.detection, {
          humanInput: true,
          privateMode: false,
          frames: false,
        });
        yield* Ref.set(accepted, Option.some(supported));
        // Frames count only when the helper itself says it sends them (#1370).
        yield* Ref.set(accepted, Option.some({ ...supported, frames: true }));
        assert.isTrue((yield* leases.detection).frames);
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
        // Only the thread's live control records a window; a replaced proxy's report changes nothing.
        assert.isFalse(yield* leases.setTarget(thread, "control:old", { pid: 9, windowId: 9 }));
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { pid: 7, windowId: 3 }));
        const recorded = (yield* leases.sessions).find(
          (entry) => entry.control.controlId === control.controlId,
        );
        assert.deepEqual(recorded?.control.target, { pid: 7, windowId: 3 });
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
