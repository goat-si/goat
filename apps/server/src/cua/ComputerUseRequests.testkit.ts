/** The real computer use request path over a running test thread, for request tests. */
import {
  AuthSessionId,
  type AuthClientSession,
  type ComputerUseCapabilities,
  type ComputerUseRequestInput,
  EnvironmentId,
  ScheduledTaskId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { requestComputerUse } from "./ComputerUseRequests.ts";
import * as CuaDriver from "./CuaDriver.ts";

export type Signals = ComputerUseCapabilities["signals"];
export const supported = { humanInput: "supported", privateMode: "supported" } satisfies Signals;

/**
 * The real leases, on a host whose helper's accepted readiness reported these signals;
 * undefined: a host whose helper never reported.
 */
export const leasesDetecting = (signals: Signals | undefined) =>
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

export const purpose = "Check the build status window";
export const sessionId = AuthSessionId.make("person:request-tests");
export const requestWithHandoffs =
  (handoffs: Handoffs.Handoffs["Service"]) =>
  (request: Partial<ComputerUseRequestInput> = {}, wait?: Duration.Duration) =>
    requestComputerUse({
      threadId,
      providerInstanceId: instanceId,
      request: { purpose, minutes: 30, ...request },
      ...(wait === undefined ? {} : { wait }),
    }).pipe(Effect.provideService(Handoffs.Handoffs, handoffs));

/** The same records with every message sent by a scheduled task. */
const fromSchedule = <T extends object>(records: T): T =>
  "messages" in records && Array.isArray(records.messages)
    ? {
        ...records,
        messages: records.messages.map((message: object) => ({
          ...message,
          scheduledTaskId: ScheduledTaskId.make("task:scheduled"),
        })),
      }
    : records;

export const withRequests = <A, E, R>(
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
  /** Sees every command the request path dispatches, once it committed. */
  observe?: (
    command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
  ) => Effect.Effect<void>,
  /** The running turn came from a scheduled task, so it is unattended work. */
  scheduled = false,
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
          (command.type === "handoff.transition" &&
          command.state === "completed" &&
          beforeCompletion !== undefined
            ? beforeCompletion(leases).pipe(Effect.andThen(orchestrator.dispatch(command)))
            : orchestrator.dispatch(command)
          ).pipe(Effect.tap(() => (observe === undefined ? Effect.void : observe(command)))),
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
          appCatalog: Effect.succeed([]),
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
          getThreadRecords: (id, fields, filter) =>
            orchestrator
              .getThreadRecords(id, fields, filter)
              .pipe(Effect.map((records) => (scheduled ? fromSchedule(records) : records))),
        }),
      ),
    ),
    Effect.provideService(HostProcess.Hostname, "test-host"),
  );
};
