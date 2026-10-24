import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database, grant } from "./ComputerUseLeases.testkit.ts";

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
    assert.equal(Option.getOrThrow(yield* leases.holder(second, undefined)).threadId, first);
    assert.isTrue(Option.isNone(yield* leases.holder(first, undefined)));
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
  "keeps threads granted different apps to their own apps, stopped one at a time, sharing the screen while both grants last",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const kakao = ThreadId.make("thread-kakao");
      const aside = ThreadId.make("thread-aside");
      yield* grant(kakao, "handoff:kakao", ["com.kakao.KakaoTalk"]);
      yield* grant(aside, "handoff:aside", ["at.studio.AsideBrowser"]);
      // One unattended control on its grant, one interactive control on its thread's grants.
      const kakaoControl = yield* leases.control(kakao, yield* leases.active(kakao));
      const asideControl = yield* leases.control(aside, Option.none());
      assert.deepInclude(yield* leases.controlState(kakao, kakaoControl.controlId), {
        _tag: "active",
        apps: ["com.kakao.KakaoTalk"],
        shared: true,
      });
      assert.deepInclude(yield* leases.controlState(aside, asideControl.controlId), {
        _tag: "active",
        apps: ["at.studio.AsideBrowser"],
        shared: true,
      });

      yield* leases.stop(kakao);
      assert.deepEqual(yield* leases.controlState(kakao, kakaoControl.controlId), {
        _tag: "ended",
        reason: "stopped",
      });
      assert.equal((yield* leases.controlState(aside, asideControl.controlId))._tag, "active");

      // Once the other grant is gone the screen is this thread's alone again.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'handoff:kakao'`;
      const alone = yield* leases.controlState(aside, asideControl.controlId);
      assert.equal(alone._tag, "active");
      assert.notProperty(alone, "shared");
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
          assert.isTrue(Option.isNone(yield* leases.holder(approved, undefined)));
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
