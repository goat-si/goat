import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseCapabilities,
  type ComputerUseRequestInput,
  EnvironmentId,
  Handoff,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
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

const requestFrom = (
  orchestrator: Parameters<Parameters<typeof withHarness>[0]>[0]["orchestrator"],
  signals: Signals | undefined,
  request: ComputerUseRequestInput = { purpose: "Check the build status window", minutes: 30 },
  failure: Option.Option<CuaDriver.CuaDriverError> = Option.none(),
) =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("test-environment");
    const { start } = yield* durableHandoffs(orchestrator, {
      environmentId,
      sessions: Effect.succeed([]),
    });
    const handoffs = yield* start;
    return requestComputerUse({
      threadId,
      providerInstanceId: instanceId,
      request,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Handoffs.Handoffs, handoffs),
          leasesDetecting(signals),
          Layer.mock(CuaDriver.CuaDriver)({
            enabled: Effect.succeed(true),
            block: Effect.succeed(CuaDriver.agentBlock(failure)),
          }),
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadSnapshot: orchestrator.getThreadSnapshot,
          }),
        ),
      ),
      Effect.provideService(HostProcess.Hostname, "test-host"),
    );
  });

it.effect(
  "work that runs on its own is refused unless the helper reports both safety signals supported",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        for (const signals of [
          undefined,
          { humanInput: "unsupported", privateMode: "unsupported" },
          { humanInput: "supported", privateMode: "unsupported" },
          { humanInput: "unsupported", privateMode: "supported" },
        ] satisfies ReadonlyArray<Signals | undefined>) {
          const result = yield* yield* requestFrom(orchestrator, signals);
          assert.equal(result.kind, "refused", JSON.stringify(signals));
          if (result.kind === "refused") assert.equal(result.reason, "detection_unsupported");
        }
        const allowed = yield* yield* requestFrom(orchestrator, supported);
        assert.equal(allowed.kind, "needs_human");
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
        const result = yield* yield* requestFrom(
          orchestrator,
          supported,
          undefined,
          Option.some(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
        );
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

it.effect("a repeated request announces the pending handoff's original expiry", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const request = yield* requestFrom(orchestrator, supported);
      const first = yield* request;
      assert.equal(first.kind, "needs_human");
      yield* TestClock.adjust("10 minutes");
      const repeated = yield* request;
      if (first.kind !== "needs_human" || repeated.kind !== "needs_human")
        return assert.fail("both requests should wait for a person");
      assert.equal(repeated.handoff.handoffId, first.handoff.handoffId);
      const expiresAt = repeated.handoff.expiresAt;
      if (expiresAt === null) return assert.fail("a computer use handoff carries its expiry");
      assert.include(repeated.message, `before ${DateTime.formatIso(expiresAt)},`);
    }),
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
          requestFrom(orchestrator, supported, {
            purpose: "Open a page in Aside",
            ...(apps === undefined ? {} : { apps }),
          }).pipe(Effect.flatten);

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
      const result = yield* yield* requestFrom(orchestrator, supported, {
        purpose: "Open a page in Aside",
        apps: ["at.studio.AsideBrowser"],
      });
      if (result.kind !== "refused") return assert.fail("the whole screen overlaps every app");
      assert.equal(result.holderThreadId, holder);
      assert.include(result.message, "whole screen");
    }),
  ),
);
