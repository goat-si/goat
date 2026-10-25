/** The asking thread mid-turn on the real orchestrator, with handoffs and the wake reactor. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthClientSession,
  type HandoffState,
  type OrchestrationV2DomainEvent,
  type TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as HandoffWakeReactor from "./HandoffWakeReactor.ts";
import * as Handoffs from "./Handoffs.ts";

export const threadId = ThreadId.make("thread:wake");
export const instanceId = ProviderInstanceId.make("codex");
export const environmentId = EnvironmentId.make("origin");
export const person = AuthSessionId.make("session:person");

export interface World {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly worker: Worker.OrchestrationEffectWorkerV2["Service"];
  readonly handoffs: Handoffs.Handoffs["Service"];
  readonly reactor: HandoffWakeReactor.HandoffWakeReactor["Service"];
  readonly sql: SqlClient.SqlClient;
  /**
   * Wake command ids sent to the orchestrator; the next `failing` fresh ones are rejected,
   * `slowMs` after they arrive. `arrived` completes when a wake reaches the orchestrator.
   */
  readonly outage: {
    failing: number;
    slowMs: number;
    /** Withdrawing a queued wake run fails. */
    failWithdraw: boolean;
    arrived: Deferred.Deferred<void>;
    readonly sent: Array<string>;
  };
}

/** The asking thread mid-turn on the real orchestrator, with handoffs and the wake reactor. */
export const withWorld = <A, E>(body: (world: World) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter(true, instanceId);
    const adapter = {
      ...fake.adapter,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (session: Parameters<typeof fake.adapter.openSession>[0]) =>
        fake.adapter
          .openSession(session)
          .pipe(Effect.map((opened) => ({ ...opened, startTurn: () => Effect.void }))),
    };
    const databaseLayer = Sqlite.layerMemory;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const sql = yield* SqlClient.SqlClient;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("project:wake"),
        title: "Wake",
        modelSelection: { instanceId, model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-run"),
        threadId,
        messageId: MessageId.make("message:wake"),
        text: "Do the thing",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const now = yield* DateTime.now;
      const secrets = new Map<string, Uint8Array>();
      const outage: World["outage"] = {
        failing: 0,
        slowMs: 0,
        failWithdraw: false,
        arrived: yield* Deferred.make<void>(),
        sent: [],
      };
      const session: AuthClientSession = {
        sessionId: person,
        subject: "browser",
        method: "browser-session-cookie",
        scopes: ["orchestration:operate", "settings:write", "providers:manage"],
        client: { label: "Laptop", deviceType: "unknown" },
        issuedAt: now,
        expiresAt: DateTime.add(now, { days: 7 }),
        lastConnectedAt: now,
        connected: true,
        current: true,
      };
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) => {
          if (command.type === "queued-run.cancel" && outage.failWithdraw)
            return Effect.fail(
              new Orchestrator.OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
              }),
            );
          if (command.type !== "message.dispatch" || !command.commandId.startsWith("server:"))
            return orchestrator.dispatch(command);
          outage.sent.push(command.commandId);
          Deferred.doneUnsafe(outage.arrived, Effect.void);
          if (outage.failing === 0) return orchestrator.dispatch(command);
          outage.failing -= 1;
          // A planning failure: the orchestrator keeps a rejected receipt under this command id.
          return Effect.sleep(outage.slowMs).pipe(
            Effect.andThen(
              sql`INSERT INTO orchestration_command_receipts
            (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
            VALUES (${command.commandId}, 'thread', ${threadId}, 'message.dispatch',
            '2026-10-23T00:00:00.000Z', 0, 'rejected', 'adapter unavailable')`.pipe(
                Effect.orDie,
                Effect.andThen(
                  Effect.fail(
                    new Orchestrator.OrchestratorCommandRejectedError({
                      commandId: command.commandId,
                      commandType: command.type,
                    }),
                  ),
                ),
              ),
            ),
          );
        },
        getThreadRecords: orchestrator.getThreadRecords,
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      });
      const services = HandoffWakeReactor.layer.pipe(
        Layer.provide(threads),
        Layer.provideMerge(
          Handoffs.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                threads,
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.succeed(environmentId),
                }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(SessionStore.SessionStore)({
                  cookieName: "test",
                  legacyCookieName: undefined,
                  listActive: () => Effect.succeed([session]),
                }),
                Layer.succeed(
                  SecretStore.ServerSecretStore,
                  SecretStore.ServerSecretStore.of({
                    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
                    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
                    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
                    remove: (name) => Effect.sync(() => void secrets.delete(name)),
                    getOrCreateRandom: (_name, size) =>
                      Effect.succeed(new Uint8Array(size).fill(7)),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        return yield* body({
          orchestrator,
          worker,
          sql,
          outage,
          handoffs: yield* Handoffs.Handoffs,
          reactor: yield* HandoffWakeReactor.HandoffWakeReactor,
        });
      }).pipe(Effect.provide(services));
    }).pipe(
      Effect.provide(
        Harness.layerWithRegistry({ name: "handoff-wake" }, Registry.layerFromAdapters([adapter]), {
          runEffectWorker: false,
          databaseLayer,
        }).pipe(Layer.provideMerge(databaseLayer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

export const startEpoch = (world: World) =>
  Effect.gen(function* () {
    const since = DateTime.formatIso(yield* DateTime.now);
    yield* world.sql`INSERT INTO handoff_wake_epoch (id, since) VALUES (1, ${since})`;
  });

export const ask = (world: World, path: string, expiresAt?: DateTime.Utc) =>
  Effect.gen(function* () {
    const run = (yield* world.orchestrator.getThreadProjection(threadId)).runs.at(-1);
    if (run === undefined || run.rootNodeId === null)
      return yield* Effect.die("the harness thread has no running turn");
    return yield* world.handoffs.create({
      kind: "approval",
      title: "Allow the change?",
      reason: "The agent needs a person.",
      requestedBy: { threadId, providerInstanceId: instanceId, path },
      target: { environmentId, path },
      runId: run.id,
      nodeId: run.rootNodeId,
      human: { location: "PRIVATE-INSTRUCTIONS" },
      args: { path },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  });

export const wakes = (world: World) =>
  world.orchestrator
    .getThreadProjection(threadId)
    .pipe(
      Effect.map((projection) =>
        projection.messages.filter((message) => message.id.startsWith("message:handoff-wake:")),
      ),
    );

/** The persisted update that resolved this handoff, as the reactor's stream delivers it. */
export const resolution = (world: World, handoffId: string, state: HandoffState = "completed") =>
  world.orchestrator
    .streamStoredEventsFrom({ afterSequence: 0, eventType: "turn-item.updated" })
    .pipe(
      Stream.map((stored) => stored.event),
      Stream.filter(
        (event): event is OrchestrationV2DomainEvent =>
          event.type === "turn-item.updated" &&
          event.payload.type === "human_handoff" &&
          event.payload.handoff?.handoffId === handoffId &&
          event.payload.handoff.state === state,
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.flatMap((events) => {
        const [event] = Array.from(events);
        return event === undefined ? Effect.die("no resolution event") : Effect.succeed(event);
      }),
    );

export const waitForComputerUse = (
  world: World,
  handoffId: TurnItemId,
  until: DateTime.Utc,
  consume = true,
) =>
  Effect.gen(function* () {
    const waiting = yield* world.handoffs
      .awaitComputerUseAnswer({ threadId, handoffId, until }, () => Effect.succeed(consume))
      .pipe(Effect.forkChild({ startImmediately: true }));
    // Let the initial read subscribe and park on the answer or its TestClock deadline.
    yield* TestClock.adjust(0);
    return waiting;
  });
