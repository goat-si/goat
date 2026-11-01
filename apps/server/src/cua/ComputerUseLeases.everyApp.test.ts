import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Statement from "effect/sql/Statement";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database, grant } from "./ComputerUseLeases.projection.testkit.ts";
import { foregroundGrant } from "./ComputerUseForeground.testkit.ts";

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
      // Off, as on a fresh host: since D16 the setting decides nothing for full access threads.
      ServerSettings.ServerSettingsService.layerTest({ cuaFullAccessAutoAdmit: false }),
    ),
  ),
);

it.effect("updates the origin policy when a full access control is reused", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-origin-policy");
    yield* threadIn(owner, "full-access");
    yield* leases.everyAppControl(owner, false, { nonPerson: true });
    assert.isTrue(Option.getOrThrow(yield* leases.currentControl(owner)).nonPersonFullAccess);
    yield* leases.everyAppControl(owner, false, { nonPerson: false });
    assert.isFalse(Option.getOrThrow(yield* leases.currentControl(owner)).nonPersonFullAccess);
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("increments the app identity epoch when another turn reuses the control", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-cache-epoch");
    yield* threadIn(owner, "full-access");
    const first = Option.getOrThrow(
      yield* leases.everyAppControl(owner, false, { runId: RunId.make("run:first") }),
    );
    const before = yield* leases.controlState(owner, first.controlId);
    yield* leases.everyAppControl(owner, false, { runId: RunId.make("run:second") });
    const after = yield* leases.controlState(owner, first.controlId);
    assert.deepInclude(before, { _tag: "active", identityEpoch: 0 });
    assert.deepInclude(after, { _tag: "active", identityEpoch: 1 });
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("a new organization denial refuses a pending ticket on validation", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const settings = yield* ServerSettings.ServerSettingsService;
    const owner = ThreadId.make("thread-denial-validation");
    yield* threadIn(owner, "full-access");
    const control = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
    const result = yield* leases.callReservation(owner, {
      action: "reserve",
      controlId: control.controlId,
      connectionId: "connection",
      callId: "one",
      interruptions: 0,
      idleEpoch: 0,
      name: "click",
      args: { pid: 42, window_id: 7 },
      app: "com.example.Editor",
    });
    assert.equal(result.status, "admitted");
    if (result.status !== "admitted" || result.reservationId === null)
      return assert.fail("missing ticket");
    yield* settings.updateSettings({
      cuaDeniedApps: ["com.example.Editor"],
      cuaStrictInputGuards: true,
    });
    const check = yield* leases.callReservation(owner, {
      action: "validate",
      controlId: control.controlId,
      connectionId: "connection",
      reservationId: result.reservationId,
    });
    assert.deepInclude(check, { status: "refused", detail: "app_not_allowed" });
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("a denial committed during admission prevents the call", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const settings = yield* ServerSettings.ServerSettingsService;
    const owner = ThreadId.make("thread-denial-race");
    yield* threadIn(owner, "full-access");
    const control = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pending = yield* leases
      .callReservation(owner, {
        action: "reserve",
        controlId: control.controlId,
        connectionId: "connection",
        callId: "one",
        interruptions: 0,
        idleEpoch: 0,
        name: "click",
        args: { pid: 42, window_id: 7 },
        app: "com.example.Editor",
      })
      .pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(statement),
          ),
        ),
        Effect.forkChild,
      );
    yield* Deferred.await(reading);
    yield* settings.updateSettings({
      cuaDeniedApps: ["com.example.Editor"],
      cuaStrictInputGuards: true,
    });
    yield* Deferred.succeed(release, undefined);
    assert.deepInclude(yield* Fiber.join(pending), {
      status: "refused",
      detail: "app_not_allowed",
    });
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect.each([true, false])(
  "checks terminal calls for full access origin (nonPerson %s)",
  (nonPerson) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make(`thread-terminal-${nonPerson}`);
      yield* threadIn(owner, "full-access");
      const control = Option.getOrThrow(yield* leases.everyAppControl(owner, false, { nonPerson }));
      for (const app of ["com.apple.Terminal", "com.googlecode.iterm2"]) {
        const result = yield* leases.callReservation(owner, {
          action: "reserve",
          controlId: control.controlId,
          connectionId: "connection",
          callId: app,
          interruptions: 0,
          idleEpoch: 0,
          name: "click",
          args: { pid: 42, window_id: 7 },
          app,
        });
        assert.equal(result.status, nonPerson ? "refused" : "admitted");
        if (result.status === "refused") assert.equal(result.detail, "app_not_allowed");
      }
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect.each(["replacement", "approval after Stop"] as const)(
  "a suspended full access read cannot revoke a newer %s",
  (transition) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-control-read-race");
      yield* threadIn(owner, "full-access");
      const first = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pending = yield* leases.controlState(owner, first.controlId).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(statement),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(reading);
      yield* threadIn(owner, "auto");
      yield* leases.stop(owner);
      const second =
        transition === "replacement" ? yield* leases.control(owner, Option.none()) : undefined;
      if (transition === "approval after Stop") yield* foregroundGrant(owner, "handoff:after-stop");
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Fiber.join(pending), { _tag: "ended", reason: "revoked" });
      if (second !== undefined)
        assert.equal((yield* leases.controlState(owner, second.controlId))._tag, "active");
      else assert.isTrue(yield* leases.foregroundAvailable(owner, "Check the build status"));
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect.each([
  { reused: true, at: "70 minutes", state: "active" },
  { reused: false, at: "60 minutes", state: "ended" },
] as const)(
  "a full access control lasts an hour from its last use (reused $reused, $at: $state)",
  ({ reused, at, state }) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make(`thread-control-hour-${String(reused)}`);
      yield* threadIn(owner, "full-access");
      const first = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
      if (reused) {
        yield* TestClock.adjust("50 minutes");
        const next = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
        assert.equal(next.controlId, first.controlId);
        yield* TestClock.adjust("20 minutes");
      } else yield* TestClock.adjust(at);
      assert.equal((yield* leases.controlState(owner, first.controlId))._tag, state);
      if (!reused) return;
      // Not unbounded: an hour after that last use it ends.
      yield* TestClock.adjust("40 minutes");
      assert.deepEqual(yield* leases.controlState(owner, first.controlId), {
        _tag: "ended",
        reason: "expired",
      });
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("reusing a full access control tells the proxies following it its new expiry", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-control-hour-notice");
    yield* threadIn(owner, "full-access");
    Option.getOrThrow(yield* leases.everyAppControl(owner, false));
    const proxies = yield* leases.subscribe;
    yield* TestClock.adjust("50 minutes");
    const before = yield* PubSub.remaining(proxies);
    Option.getOrThrow(yield* leases.everyAppControl(owner, false));
    assert.isAbove(yield* PubSub.remaining(proxies), before);
  }).pipe(Effect.scoped, Effect.provide(everyAppLayer)),
);

it.effect(
  "calls every 30 s announce each move of the control's expiry, never leaving it unsaid",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-control-hour-frequent");
      yield* threadIn(owner, "full-access");
      Option.getOrThrow(yield* leases.everyAppControl(owner, false));
      const proxies = yield* leases.subscribe;
      let expiry = 60 * 60_000;
      for (let step = 1; step <= 6; step++) {
        yield* TestClock.adjust("30 seconds");
        const before = yield* PubSub.remaining(proxies);
        const reused = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
        const next = DateTime.toEpochMillis(reused.expiresAt);
        // Within the minute before an hour from this use, never past it.
        assert.isAtMost(next, step * 30_000 + 60 * 60_000);
        assert.isAbove(next, step * 30_000 + 59 * 60_000);
        assert.equal((yield* PubSub.remaining(proxies)) > before, next !== expiry);
        expiry = next;
      }
      assert.equal(expiry, 63 * 60_000);
    }).pipe(Effect.scoped, Effect.provide(everyAppLayer)),
);

it.effect("a control minted between minutes never outlasts an hour from that use", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const owner = ThreadId.make("thread-control-hour-between");
    yield* threadIn(owner, "full-access");
    yield* TestClock.adjust("30 seconds");
    const control = Option.getOrThrow(yield* leases.everyAppControl(owner, false));
    yield* TestClock.adjust(59 * 60_000 + 29_999);
    assert.equal((yield* leases.controlState(owner, control.controlId))._tag, "active");
    yield* TestClock.adjust(1);
    assert.deepEqual(yield* leases.controlState(owner, control.controlId), {
      _tag: "ended",
      reason: "expired",
    });
  }).pipe(Effect.provide(everyAppLayer)),
);

it.effect("gives a full access thread every app until it leaves full access", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const auto = ThreadId.make("thread-auto");
    yield* threadIn(auto, "full-access");
    const claim = () =>
      leases.everyAppControl(auto, false).pipe(Effect.map((control) => Option.getOrThrow(control)));
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

it.effect(
  "D16: keeps full access controls of a person, an interactive wake and unattended work with the host setting off, until each thread leaves full access",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const settings = yield* ServerSettings.ServerSettingsService;
      const directed = ThreadId.make("thread-directed-no-setting");
      const woken = ThreadId.make("thread-woken-no-setting");
      const scheduled = ThreadId.make("thread-scheduled-no-setting");
      for (const id of [directed, woken, scheduled]) yield* threadIn(id, "full-access");
      const controls = [
        [
          directed,
          yield* leases.everyAppControl(directed, false, {
            runId: RunId.make("run:directed"),
          }),
        ],
        [woken, yield* leases.everyAppControl(woken, false, { runId: RunId.make("run:woken") })],
        [scheduled, yield* leases.everyAppControl(scheduled, true)],
      ] as const;
      // Turning the old setting on and off again changes nothing for any of them.
      yield* settings.updateSettings({ cuaFullAccessAutoAdmit: true });
      yield* settings.updateSettings({ cuaFullAccessAutoAdmit: false });
      for (const [threadId, control] of controls) {
        const state = yield* leases.controlState(threadId, Option.getOrThrow(control).controlId);
        assert.equal(state._tag, "active");
        assert.isUndefined(state._tag === "active" ? state.apps : "not active");
      }
      // Leaving full access still ends each control at once.
      for (const [threadId, control] of controls) {
        yield* threadIn(threadId, "approval-required");
        assert.deepEqual(
          yield* leases.controlState(threadId, Option.getOrThrow(control).controlId),
          { _tag: "ended", reason: "revoked" },
        );
      }
      yield* leases.stopAll;
    }).pipe(Effect.provide(everyAppLayer)),
);

it.effect(
  "a person's full access run loses its implied foreground when it ends, though a queued run keeps the control (#1617)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-person-run-ends");
      yield* threadIn(threadId, "full-access");
      const run = (id: string, status: string, ordinal: number) =>
        sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${id}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-01-01', '{}')
          ON CONFLICT (run_id) DO UPDATE SET status = excluded.status`;
      yield* run("run:R", "running", 1);
      const control = Option.getOrThrow(
        yield* leases.everyAppControl(threadId, false, {
          runId: RunId.make("run:R"),
        }),
      );
      assert.isTrue(yield* leases.foregroundAvailable(threadId, "Check the build status"));
      // R ends while Q waits in the queue: the control stays for Q, R's foreground does not.
      yield* run("run:Q", "queued", 2);
      yield* run("run:R", "completed", 1);
      const signals = yield* leases.subscribe;
      if ((yield* PubSub.remaining(signals)) > 0) yield* PubSub.takeAll(signals);
      assert.isFalse(yield* leases.turnEnded(threadId));
      assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build status"));
      // Proxies learn of the revocation from this update and stop a script already under way.
      assert.isAbove(yield* PubSub.remaining(signals), 0);
      const state = yield* leases.controlState(threadId, control.controlId);
      assert.equal(state._tag, "active");
      assert.isUndefined(state._tag === "active" ? state.foreground : "not active");
      yield* leases.stopAll;
    }).pipe(Effect.scoped, Effect.provide(everyAppLayer)),
);

it.effect(
  "a run's end tells proxies its implied foreground is gone even when reading the thread's open work fails (#1617)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-person-run-ends-read-fails");
      yield* threadIn(threadId, "full-access");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run:R2', ${threadId}, 1, 'codex', 'running', '2026-01-01', '{}')`;
      yield* leases.everyAppControl(threadId, false, { runId: RunId.make("run:R2") });
      assert.isTrue(yield* leases.foregroundAvailable(threadId, "Check the build status"));
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run:R2'`;
      const signals = yield* leases.subscribe;
      if ((yield* PubSub.remaining(signals)) > 0) yield* PubSub.takeAll(signals);
      // The open-work read fails after the ended run was found; the revocation must still publish.
      yield* sql`ALTER TABLE orchestration_v2_projection_subagents RENAME TO subagents_unavailable`;
      const failed = yield* Effect.exit(leases.turnEnded(threadId));
      yield* sql`ALTER TABLE subagents_unavailable RENAME TO orchestration_v2_projection_subagents`;
      assert.isTrue(Exit.isFailure(failed));
      assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build status"));
      assert.isAbove(yield* PubSub.remaining(signals), 0);
      yield* leases.stopAll;
    }).pipe(Effect.scoped, Effect.provide(everyAppLayer)),
);

it.effect(
  "permits a verified ordinary batch but rejects a terminal batch for a remote origin",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const owner = ThreadId.make("thread-remote-batch");
      yield* threadIn(owner, "full-access");
      const control = Option.getOrThrow(
        yield* leases.everyAppControl(owner, false, { nonPerson: true }),
      );
      for (const app of ["com.example.Editor", "com.apple.Terminal"]) {
        const result = yield* leases.callReservation(owner, {
          action: "reserve",
          controlId: control.controlId,
          connectionId: "connection",
          callId: app,
          interruptions: 0,
          idleEpoch: 0,
          name: "run_steps",
          args: { app_scope: { apps: [app], delivery: "background" }, steps: [] },
          safetyApps: [app],
        });
        assert.equal(result.status, app === "com.apple.Terminal" ? "refused" : "admitted");
        if (result.status === "refused") assert.equal(result.detail, "app_not_allowed");
      }
    }).pipe(Effect.provide(everyAppLayer)),
);
