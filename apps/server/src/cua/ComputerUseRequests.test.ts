import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthClientSession,
  type ComputerUseCapabilities,
  type ComputerUseRequestInput,
  EnvironmentId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  Handoff,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { cuaRequestableApps } from "@goat/shared/cuaDriverManifest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { requestComputerUse } from "./ComputerUseRequests.ts";
import * as CuaDriver from "./CuaDriver.ts";

type Signals = ComputerUseCapabilities["signals"];
const supported = { humanInput: "supported", privateMode: "supported" } satisfies Signals;

/**
 * The real leases, on a host whose helper's accepted readiness reported these signals;
 * undefined: a host whose helper never reported.
 */
const leasesDetecting = (signals: Signals | undefined) =>
  ComputerUseLeases.layer.pipe(
    Layer.provide(
      DesktopTelemetryReceiver.layerTest({
        cuaReadiness: Effect.succeed(
          signals === undefined
            ? Option.none()
            : Option.some({
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
              } as const),
        ),
      }),
    ),
  );

const purpose = "Check the build status window";
const sessionId = AuthSessionId.make("person:request-tests");
const requestWithHandoffs =
  (handoffs: Handoffs.Handoffs["Service"]) =>
  (request: Partial<ComputerUseRequestInput> = {}) =>
    requestComputerUse({
      threadId,
      providerInstanceId: instanceId,
      request: { purpose, minutes: 30, ...request },
    }).pipe(Effect.provideService(Handoffs.Handoffs, handoffs));

const withRequests = <A, E, R>(
  orchestrator: Parameters<Parameters<typeof withHarness>[0]>[0]["orchestrator"],
  signals: Signals | undefined,
  body: (input: {
    request: ReturnType<typeof requestWithHandoffs>;
    handoffs: Handoffs.Handoffs["Service"];
    leases: ComputerUseLeases.ComputerUseLeases["Service"];
  }) => Effect.Effect<A, E, R>,
  beforeCompletion?: (
    leases: ComputerUseLeases.ComputerUseLeases["Service"],
  ) => Effect.Effect<void>,
  failure: Option.Option<CuaDriver.CuaDriverError> = Option.none(),
  // The failure a fresh start reports; acquire records each start it is asked for.
  retry: { after: Option.Option<CuaDriver.CuaDriverError>; starts: number } = {
    after: failure,
    starts: 0,
  },
  listedApps: Option.Option<ReadonlyArray<string>> = Option.none(),
) => {
  let current = failure;
  return Effect.gen(function* () {
    const environmentId = EnvironmentId.make("test-environment");
    const now = yield* DateTime.now;
    const person: AuthClientSession = {
      sessionId,
      subject: "desktop-bootstrap",
      method: "browser-session-cookie",
      scopes: ["orchestration:operate", "settings:write"],
      client: { label: "Test person", deviceType: "desktop" },
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 1 }),
      lastConnectedAt: now,
      connected: true,
      current: true,
    };
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const { start } = yield* durableHandoffs(
      {
        ...orchestrator,
        dispatch: (command) =>
          command.type === "handoff.transition" &&
          command.state === "completed" &&
          beforeCompletion !== undefined
            ? beforeCompletion(leases).pipe(Effect.andThen(orchestrator.dispatch(command)))
            : orchestrator.dispatch(command),
      },
      {
        environmentId,
        sessions: Effect.succeed([person]),
      },
    );
    const handoffs = yield* start;
    return yield* body({
      request: requestWithHandoffs(handoffs),
      handoffs,
      leases,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        leasesDetecting(signals),
        Layer.mock(CuaDriver.CuaDriver)({
          enabled: Effect.succeed(true),
          listedApps: Effect.succeed(listedApps),
          block: Effect.sync(() => CuaDriver.agentBlock(current)),
          acquire: Effect.sync(() => {
            retry.starts += 1;
            current = retry.after;
            return Option.none();
          }),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadSnapshot: orchestrator.getThreadSnapshot,
        }),
      ),
    ),
    Effect.provideService(HostProcess.Hostname, "test-host"),
  );
};

it.effect(
  "refuses a window title absent from the host app listing without creating an approval (#1536)",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request }) =>
          Effect.gen(function* () {
            const result = yield* request({ apps: ["GOAT computer use fixture"] });
            const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
            assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
            assert.equal(result.kind, "refused");
            if (result.kind !== "refused")
              return assert.fail("an unknown app must not ask a person");
            assert.equal(result.reason, "unknown_app");
            assert.deepEqual(result.unknownApps, ["GOAT computer use fixture"]);
            for (const guidance of [
              "list_apps",
              "window title",
              "open it first",
              "bundle_id",
              "executable path",
            ])
              assert.include(result.message, guidance);
          }),
        undefined,
        undefined,
        undefined,
        Option.some(["computer-use-windows-fixture.exe"]),
      ),
    ),
);

it.effect("admits an attested executable from a partial listing but refuses a window title", () =>
  withHarness(({ orchestrator }) =>
    withRequests(
      orchestrator,
      supported,
      ({ request }) =>
        Effect.gen(function* () {
          assert.equal((yield* request({ apps: ["c:\\apps\\editor.exe"] })).kind, "needs_human");
          const refused = yield* request({ apps: ["Editor window"] });
          assert.equal(refused.kind, "refused");
          if (refused.kind !== "refused") return assert.fail("a title is not an app identity");
          assert.equal(refused.reason, "unknown_app");
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.equal(records.turnItems.filter((item) => item.type === "human_handoff").length, 1);
        }),
      undefined,
      undefined,
      undefined,
      Option.some(
        cuaRequestableApps([{ name: "Editor.exe", executable: "C:\\Apps\\Editor.exe" }], []),
      ),
    ),
  ),
);

// #1598: a credential store is refused even when the host cannot list its apps.
it.effect.each([Option.some(["com.example.Editor"]), Option.none<ReadonlyArray<string>>()])(
  "refuses a password manager without asking a person, whether or not the listing is available (%s)",
  (listing) =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request }) =>
          Effect.gen(function* () {
            for (const app of ["NordPass", "me.proton.pass.electron", "com.1password.safari"]) {
              const result = yield* request({ apps: ["com.example.Editor", app] });
              assert.equal(result.kind, "refused");
              if (result.kind !== "refused") return assert.fail(`${app} must not ask a person`);
              assert.equal(result.reason, "unknown_app");
              assert.deepEqual(result.unknownApps, [app]);
              assert.include(result.message, "password");
            }
            const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
            assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
          }),
        undefined,
        undefined,
        undefined,
        listing,
      ),
    ),
);

it.effect.each([Option.some(["COM.EXAMPLE.EDITOR"]), Option.none<ReadonlyArray<string>>()])(
  "a listed app matches case-insensitively and an unavailable listing keeps approval behavior (%s)",
  (listing) =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request }) =>
          Effect.gen(function* () {
            const result = yield* request({ apps: ["com.example.Editor"] });
            assert.equal(result.kind, "needs_human");
            const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
            assert.equal(
              records.turnItems.filter((item) => item.type === "human_handoff").length,
              1,
            );
          }),
        undefined,
        undefined,
        undefined,
        listing,
      ),
    ),
);

it.effect(
  "work that runs on its own requires private-field detection but not human-input detection",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        for (const signals of [
          undefined,
          { humanInput: "unsupported", privateMode: "unsupported" },
          { humanInput: "unsupported", privateMode: "unsupported" },
          { humanInput: "supported", privateMode: "unsupported" },
        ] satisfies ReadonlyArray<Signals | undefined>) {
          const result = yield* withRequests(orchestrator, signals, ({ request }) => request());
          assert.equal(result.kind, "refused", JSON.stringify(signals));
          if (result.kind === "refused") assert.equal(result.reason, "detection_unsupported");
        }
        for (const humanInput of ["supported", "unsupported"] as const) {
          const allowed = yield* withRequests(
            orchestrator,
            { humanInput, privateMode: "supported" },
            ({ request }) => request(),
          );
          assert.equal(allowed.kind, "needs_human");
        }
      }),
    ),
);

it.effect(
  "refuses with the missing grant when the desktop would not start the driver for it (#1399)",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const block = {
          reason: "permissionsNotGranted",
          missing: ["screenRecording"],
          holder: "helper",
        } as const;
        const retry = { after: Option.none<CuaDriver.CuaDriverError>(), starts: 0 };
        const result = yield* withRequests(
          orchestrator,
          supported,
          ({ request }) => request(),
          undefined,
          Option.some(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
          retry,
        );
        // Only a person changes a macOS grant, so asking again does not restart the driver.
        assert.equal(retry.starts, 0);
        assert.deepEqual(result, {
          kind: "refused",
          reason: "not_granted",
          block,
          message:
            "Computer use cannot start: macOS has not allowed GOAT Computer Use in Screen & System Audio Recording. A person turns it on in System Settings > Privacy & Security.",
        });
      }),
    ),
);

it.effect(
  "refuses with the Windows desktop's own reason when the helper cannot use it (#1516)",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const block = {
          reason: "desktopUnavailable",
          blocker: "screenLocked",
          detail:
            "The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
        } as const;
        const locked = Option.some(
          new CuaDriver.CuaDriverHostError({ operation: "desktop", block }),
        );
        const retry = { after: locked, starts: 0 };
        const result = yield* withRequests(
          orchestrator,
          supported,
          ({ request }) => request(),
          undefined,
          locked,
          retry,
        );
        assert.deepEqual(result, {
          kind: "refused",
          reason: "not_granted",
          block,
          message:
            "Computer use cannot start: The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
        });
        // Still locked when asked again: one fresh start, and the refusal stands.
        assert.equal(retry.starts, 1);
      }),
    ),
);

it.effect(
  "after the person unlocks Windows, asking again in the same turn goes through (#1516)",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const block = {
          reason: "desktopUnavailable",
          blocker: "screenLocked",
          detail:
            "The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
        } as const;
        // Nothing reports the unlock; only a fresh start can find the desktop usable again.
        const retry = { after: Option.none<CuaDriver.CuaDriverError>(), starts: 0 };
        const result = yield* withRequests(
          orchestrator,
          supported,
          ({ request }) => request(),
          undefined,
          Option.some(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
          retry,
        );
        assert.equal(result.kind, "needs_human");
        assert.equal(retry.starts, 1);
      }),
    ),
);

it.effect(
  "the approval says once, in words a person reads, what is asked: no run id, ISO time or second summary",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
          Effect.gen(function* () {
            const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
            for (const asked of [
              { apps: ["com.example.build"] },
              { foreground: true },
            ] satisfies Array<Partial<ComputerUseRequestInput>>) {
              const result = yield* request(asked);
              if (result.kind !== "needs_human")
                return assert.fail("the request waits for a person");
              const card = yield* handoffs.open(
                { threadId, handoffId: result.handoff.handoffId },
                sessionId,
              );
              const reason = card.handoff.reason;
              // The card shows the expiry in the reader's own time, so the text carries no clock time.
              assert.notMatch(reason, /UTC|run:|%3A/);
              assert.notMatch(reason, iso);
              assert.include(reason, `for 30 minutes: ${purpose}`);
              const details = card.human?.location ?? "";
              // What the card shows after "Review request" adds to the summary; it does not repeat it.
              assert.notInclude(details, "asks to");
              assert.notInclude(details, purpose);
              assert.notMatch(details, /run:|%3A|UTC/);
              assert.notMatch(details, iso);
            }
          }),
        );
      }),
    ),
);

it.effect("a repeated request announces the pending handoff's original expiry", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request }) =>
      Effect.gen(function* () {
        const first = yield* request();
        assert.equal(first.kind, "needs_human");
        yield* TestClock.adjust("10 minutes");
        const repeated = yield* request();
        if (first.kind !== "needs_human" || repeated.kind !== "needs_human")
          return assert.fail("both requests should wait for a person");
        assert.equal(repeated.handoff.handoffId, first.handoff.handoffId);
        const expiresAt = repeated.handoff.expiresAt;
        if (expiresAt === null) return assert.fail("a computer use handoff carries its expiry");
        assert.include(repeated.message, `before ${DateTime.formatIso(expiresAt)},`);
      }),
    ),
  ),
);

it.effect(
  "foreground with any apps list refuses desktop-only approval without creating a handoff",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          for (const apps of [[], ["com.example.editor"]]) {
            const result = yield* request({ foreground: true, apps });
            assert.equal(result.kind, "refused");
            if (result.kind !== "refused")
              return assert.fail("foreground must not broaden an apps list");
            assert.equal(result.reason, "unsupported");
            assert.include(result.message, "whole-desktop");
          }
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
        }),
      ),
    ),
);

it.effect.each(["first", "existing"] as const)(
  "reuses a shorter foreground approval over app-only admission (control: %s)",
  (ordering) =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
        Effect.gen(function* () {
          const apps = ["com.example.AppA"];
          const background = yield* request({ apps, minutes: 10 });
          if (background.kind !== "needs_human") return assert.fail("background needs approval");
          const admitted = yield* handoffs.respond(
            { threadId, handoffId: background.handoff.handoffId, action: "completed" },
            sessionId,
          );
          if (admitted.expiresAt === null) return assert.fail("admission needs an expiry");
          if (ordering === "existing")
            yield* leases.control(threadId, yield* leases.active(threadId));
          const focus = yield* request({ foreground: true, minutes: 5 });
          if (focus.kind !== "needs_human") return assert.fail("foreground needs approval");
          yield* handoffs.respond(
            { threadId, handoffId: focus.handoff.handoffId, action: "completed" },
            sessionId,
          );
          const control = yield* leases.control(threadId, yield* leases.active(threadId));
          const state = yield* leases.controlState(threadId, control.controlId);
          assert.equal(state._tag, "active");
          assert.isUndefined(state._tag === "active" ? state.apps : state);
          assert.isTrue(yield* leases.foregroundAvailable(threadId, purpose));
          const repeated = yield* request({ foreground: true, minutes: 5 });
          assert.equal(repeated.kind, "available", "Matching live authority must not ask again");
          assert.include(repeated.message, "whole-desktop foreground");
          assert.notInclude(repeated.message, DateTime.formatIso(admitted.expiresAt));
          assert.equal(
            (yield* request({ foreground: true, purpose: "A different purpose" })).kind,
            "needs_human",
          );
          yield* TestClock.adjust("5 minutes");
          assert.equal((yield* request({ foreground: true })).kind, "needs_human");
          assert.equal((yield* request({ apps })).kind, "available");
        }),
      ),
    ),
);

it.effect("a background approval cannot satisfy a foreground request for the same purpose", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const background = yield* request();
        if (background.kind !== "needs_human") return assert.fail("background waits for approval");
        yield* handoffs.respond(
          { threadId, handoffId: background.handoff.handoffId, action: "completed" },
          sessionId,
        );
        assert.equal((yield* request({ foreground: false })).kind, "available");
        const foreground = yield* request({ foreground: true });
        assert.equal(foreground.kind, "needs_human");
        if (foreground.kind === "needs_human")
          assert.notEqual(foreground.handoff.handoffId, background.handoff.handoffId);
      }),
    ),
  ),
);

it.effect(
  "omitted and false reuse legacy background args while true has separate persisted disclosure",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const omitted = yield* request();
          const explicitFalse = yield* request({ foreground: false });
          const foreground = yield* request({ foreground: true });
          const repeated = yield* request({ foreground: true });
          if (
            omitted.kind !== "needs_human" ||
            explicitFalse.kind !== "needs_human" ||
            foreground.kind !== "needs_human" ||
            repeated.kind !== "needs_human"
          )
            return assert.fail("pending modes should each wait for a person");
          assert.equal(explicitFalse.handoff.handoffId, omitted.handoff.handoffId);
          assert.equal(repeated.handoff.handoffId, foreground.handoff.handoffId);
          assert.notEqual(foreground.handoff.handoffId, omitted.handoff.handoffId);
          const backgroundCard = yield* handoffs.open(
            { threadId, handoffId: omitted.handoff.handoffId },
            sessionId,
          );
          assert.isUndefined(backgroundCard.handoff.computerUseForeground);
          assert.include(backgroundCard.handoff.reason, "Background-only");
          assert.notInclude(backgroundCard.handoff.reason, "already sent");
          assert.notInclude(backgroundCard.human?.location ?? "", "already sent");
          const card = yield* handoffs.open(
            { threadId, handoffId: foreground.handoff.handoffId },
            sessionId,
          );
          assert.deepEqual(card.handoff.computerUseForeground, { purpose, target: "desktop" });
          assert.isUndefined(card.handoff.apps);
          for (const required of [purpose, "Whole-desktop foreground", "focus"])
            assert.include(card.handoff.reason, required);
          for (const required of [
            "Pause",
            "Stop",
            "replacement",
            "turn end",
            "one input action already sent under live approval",
            "GOAT does not restore focus when approval ends",
          ])
            assert.include(card.human?.location ?? "", required);
        }),
      ),
    ),
);

it.effect(
  "a person's first completion binds the purpose once; pause and repeated completion cannot resurrect it",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
        Effect.gen(function* () {
          const asked = yield* request({ foreground: true });
          if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
          const address = { threadId, handoffId: asked.handoff.handoffId };
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          yield* handoffs.respond({ ...address, action: "opened" }, sessionId);
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          const completed = yield* handoffs.respond({ ...address, action: "completed" }, sessionId);
          assert.deepEqual(completed.computerUseForeground, { purpose, target: "desktop" });
          yield* leases.control(threadId, yield* leases.active(threadId));
          assert.isTrue(yield* leases.foregroundAvailable(threadId, purpose));
          assert.equal((yield* request({ foreground: true })).kind, "available");
          assert.equal(
            (yield* request({ foreground: true, purpose: "A different purpose" })).kind,
            "needs_human",
          );
          const persisted = yield* handoffs.read(address);
          assert.deepEqual(persisted.computerUseForeground, completed.computerUseForeground);
          // A fresh server's map cannot be rebuilt from the completed projection.
          const afterRestart = yield* Effect.gen(function* () {
            const fresh = yield* ComputerUseLeases.ComputerUseLeases;
            return yield* fresh.foregroundAvailable(threadId, purpose);
          }).pipe(Effect.provide(Layer.fresh(leasesDetecting(supported))));
          assert.isFalse(afterRestart);
          yield* leases.pause("takeover");
          yield* leases.resume;
          yield* handoffs.respond({ ...address, action: "completed" }, sessionId);
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          assert.equal((yield* request({ foreground: true })).kind, "needs_human");
          assert.equal((yield* request()).kind, "available");
        }),
      ),
    ),
);

it.effect(
  "Stop between the first approval read and its commit fences foreground authority even without a control",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            const asked = yield* request({ foreground: true });
            if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
            const completed = yield* handoffs.respond(
              { threadId, handoffId: asked.handoff.handoffId, action: "completed" },
              sessionId,
            );
            assert.equal(completed.state, "completed");
            yield* leases.control(threadId, yield* leases.active(threadId));
            assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
            assert.equal((yield* request({ foreground: true })).kind, "needs_human");
          }),
        (leases) => leases.stop(threadId).pipe(Effect.asVoid),
      ),
    ),
);

it.effect("an expired foreground request never binds authority when a person completes it", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const asked = yield* request({ foreground: true });
        if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
        yield* TestClock.adjust("30 minutes");
        const result = yield* handoffs
          .respond({ threadId, handoffId: asked.handoff.handoffId, action: "completed" }, sessionId)
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "HandoffError");
        assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
      }),
    ),
  ),
);

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Handoff)));

/** An approved grant of another thread on this host, live for an hour. */
const grantElsewhere = (holder: ThreadId, apps: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const id = `grant:${holder}`;
    const handoff: Handoff = {
      handoffId: TurnItemId.make(id),
      kind: "approval",
      title: "Allow computer use?",
      reason: "test",
      requestedBy: {
        threadId: holder,
        providerInstanceId: instanceId,
        path: COMPUTER_USE_GRANT_HANDOFF_PATH,
      },
      target: {
        environmentId: EnvironmentId.make("test-environment"),
        path: COMPUTER_USE_GRANT_HANDOFF_PATH,
      },
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
      VALUES (${id}, ${holder}, 'run', 0, 'human_handoff', 'completed', '2026-01-01',
        ${'{"handoff":' + encodeHandoff(handoff) + "}"})
    `;
  });

it.effect(
  "regression: another thread's grant refuses only a request for one of its apps or the whole screen",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const holder = ThreadId.make("thread:kakao");
        yield* grantElsewhere(holder, ["com.kakao.KakaoTalk"]);
        const ask = (apps?: ReadonlyArray<string>) =>
          withRequests(orchestrator, supported, ({ request }) =>
            request({
              purpose: "Open a page in Aside",
              ...(apps === undefined ? {} : { apps }),
            }),
          );

        assert.equal((yield* ask(["at.studio.AsideBrowser"])).kind, "needs_human");

        const sameApp = yield* ask(["at.studio.AsideBrowser", "com.kakao.kakaotalk"]);
        if (sameApp.kind !== "refused") return assert.fail("a shared app stays one thread's");
        assert.equal(sameApp.reason, "held");
        assert.equal(sameApp.holderThreadId, holder);
        assert.include(sameApp.message, "com.kakao.KakaoTalk");
        assert.notInclude(sameApp.message, "AsideBrowser");

        const screen = yield* ask();
        if (screen.kind !== "refused") return assert.fail("the whole screen overlaps every app");
        assert.equal(screen.holderThreadId, holder);
        assert.include(screen.message, "com.kakao.KakaoTalk");
      }),
    ),
);

it.effect("another thread's whole-screen grant still refuses a request for any app", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const holder = ThreadId.make("thread:screen");
      yield* grantElsewhere(holder, undefined);
      const result = yield* withRequests(orchestrator, supported, ({ request }) =>
        request({
          purpose: "Open a page in Aside",
          apps: ["at.studio.AsideBrowser"],
        }),
      );
      if (result.kind !== "refused") return assert.fail("the whole screen overlaps every app");
      assert.equal(result.holderThreadId, holder);
      assert.include(result.message, "whole screen");
    }),
  ),
);
