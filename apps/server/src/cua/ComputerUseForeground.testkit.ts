import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentId,
  ProviderInstanceId,
  TurnItemId,
  Handoff,
  type ThreadId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
export const foregroundDatabase = database;
export const foregroundServiceLayer = Layer.merge(
  database,
  ComputerUseLeases.layer.pipe(Layer.provide(Layer.merge(database, NodeServices.layer))),
);
export const foregroundProxyLayer = Layer.merge(
  foregroundServiceLayer,
  ServerSettings.ServerSettingsService.layerTest({ enableCua: true }),
);
const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Handoff)));

/** A completed admission fixture; tests of human authority use the actual Handoffs transition. */
export const foregroundGrant = Effect.fn("foreground.fixtureGrant")(function* (
  threadId: ThreadId,
  id: string,
  options: {
    readonly purpose?: string;
    readonly approve?: boolean;
    readonly minutes?: number;
    readonly observedEpoch?: number;
    readonly apps?: ReadonlyArray<string>;
    readonly foreground?: boolean;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const now = yield* DateTime.now;
  const handoff: Handoff = {
    handoffId: TurnItemId.make(id),
    kind: "approval",
    title: "Allow foreground control?",
    reason: "Check the build status",
    requestedBy: {
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      path: COMPUTER_USE_GRANT_HANDOFF_PATH,
    },
    target: {
      environmentId: EnvironmentId.make("environment:test"),
      path: COMPUTER_USE_GRANT_HANDOFF_PATH,
    },
    dedupeKey: id,
    state: "completed",
    expiresAt: DateTime.add(now, { minutes: options.minutes ?? 30 }),
    createdAt: now,
    resolvedAt: now,
    resolvedBy: "Test client",
    actor: { type: "client", label: "Test client" },
    ...(options.foreground === false
      ? {}
      : {
          computerUseForeground: {
            purpose: options.purpose ?? "Check the build status",
            target: "desktop" as const,
          },
        }),
    ...(options.apps === undefined ? {} : { apps: options.apps }),
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${id}, ${threadId}, 'run', 0, 'human_handoff', 'completed', '2026-01-01',
      ${'{"handoff":' + encodeHandoff(handoff) + "}"})
  `;
  if (options.approve !== false)
    yield* leases.approveForeground(
      handoff,
      options.observedEpoch ?? (yield* leases.foregroundApprovalEpoch),
    );
  return handoff;
});

export const revokeForegroundGrant = Effect.fn("foreground.fixtureRevoke")(function* (
  handoffId: TurnItemId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_projection_turn_items
    SET status = 'cancelled', payload_json = json_set(payload_json, '$.handoff.state', 'cancelled')
    WHERE turn_item_id = ${handoffId}`;
  yield* (yield* ComputerUseLeases.ComputerUseLeases).changed;
});

export const controlWithForeground = Effect.fn("foreground.fixtureControl")(function* (
  threadId: ThreadId,
) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const control = yield* leases.control(threadId, Option.none());
  return { leases, control };
});

export const foregroundProxy = Effect.fn("foreground.fixtureProxy")(function* (
  threadId: ThreadId,
  options: {
    readonly kill?: (index: number) => Effect.Effect<void>;
  } = {},
) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const settings = yield* ServerSettings.ServerSettingsService;
  const background = yield* foregroundGrant(threadId, "handoff:lifecycle-background", {
    foreground: false,
    minutes: 60,
  });
  const admission = yield* leases.state(threadId, background.handoffId);
  if (admission._tag !== "active") return yield* Effect.die("expected background admission");
  const control = yield* leases.control(threadId, Option.some(admission.lease));
  const grant = yield* foregroundGrant(threadId, "handoff:lifecycle-foreground", { minutes: 5 });
  const humanReports = yield* Queue.unbounded<"paused" | "agents" | "refused">();
  const h = yield* harness({
    controlId: control.controlId,
    expiresAt: DateTime.formatIso(control.expiresAt),
    leaseUpdates: leaseUpdates({ threadId, controlId: control.controlId }).pipe(
      Stream.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      Stream.provideService(ServerSettings.ServerSettingsService, settings),
    ),
    reservation: (request) => leases.callReservation(threadId, request).pipe(Effect.orDie),
    ...(options.kill === undefined ? {} : { kill: options.kill }),
    humanInput: true,
    onHumanInput: (events) =>
      leases.humanInput(threadId, control.controlId, events).pipe(
        Effect.tap((outcome) => Queue.offer(humanReports, outcome)),
        Effect.map((outcome) => outcome === "paused"),
      ),
    onAgentInput: (report) =>
      leases.agentInput(threadId, control.controlId, report).pipe(Effect.asVoid),
  });
  return {
    h,
    leases,
    control,
    grant,
    admission: admission.lease,
    humanReport: Queue.take(humanReports),
  };
});
