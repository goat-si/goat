import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { requestComputerUse } from "./ComputerUseRequests.ts";
import * as CuaDriver from "./CuaDriver.ts";

it.effect("a repeated request announces the pending handoff's original expiry", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("test-environment");
      const { start } = yield* durableHandoffs(orchestrator, {
        environmentId,
        sessions: Effect.succeed([]),
      });
      const handoffs = yield* start;
      const request = requestComputerUse({
        threadId,
        providerInstanceId: instanceId,
        request: { purpose: "Check the build status window", minutes: 30 },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Handoffs.Handoffs, handoffs),
            ComputerUseLeases.layer,
            Layer.mock(CuaDriver.CuaDriver)({ enabled: Effect.succeed(true) }),
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
