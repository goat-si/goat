import { assert, it } from "@effect/vitest";
import { type ComputerUseCapabilities, EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
      request: { purpose: "Check the build status window", minutes: 30 },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Handoffs.Handoffs, handoffs),
          leasesDetecting(signals),
          Layer.mock(CuaDriver.CuaDriver)({
            enabled: Effect.succeed(true),
            status: Effect.succeed({
              platform: "darwin",
              running: false,
              ...(Option.isSome(failure) && failure.value._tag === "CuaDriverHostError"
                ? { block: failure.value.block }
                : {}),
            }),
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
