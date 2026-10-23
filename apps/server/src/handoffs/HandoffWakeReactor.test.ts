import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthClientSession,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
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

const threadId = ThreadId.make("thread:wake");
const instanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("origin");
const person = AuthSessionId.make("session:person");

interface World {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly worker: Worker.OrchestrationEffectWorkerV2["Service"];
  readonly handoffs: Handoffs.Handoffs["Service"];
  readonly reactor: HandoffWakeReactor.HandoffWakeReactor["Service"];
  readonly sql: SqlClient.SqlClient;
}

/** The asking thread mid-turn on the real orchestrator, with handoffs and the wake reactor. */
const withWorld = <A, E>(body: (world: World) => Effect.Effect<A, E>) =>
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
      const session: AuthClientSession = {
        sessionId: person,
        subject: "browser",
        method: "browser-session-cookie",
        scopes: ["orchestration:operate", "settings:write"],
        client: { label: "Laptop", deviceType: "unknown" },
        issuedAt: now,
        expiresAt: DateTime.add(now, { days: 7 }),
        lastConnectedAt: now,
        connected: true,
        current: true,
      };
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      });
      const services = Layer.mergeAll(
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
                  get: () => Effect.succeed(Option.none()),
                  set: () => Effect.void,
                  create: () => Effect.void,
                  remove: () => Effect.void,
                  getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(7)),
                }),
              ),
            ),
          ),
        ),
        HandoffWakeReactor.layer.pipe(Layer.provide(threads)),
      );
      return yield* Effect.gen(function* () {
        return yield* body({
          orchestrator,
          worker,
          sql,
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

const startEpoch = (world: World) =>
  Effect.gen(function* () {
    const since = DateTime.formatIso(yield* DateTime.now);
    yield* world.sql`INSERT INTO handoff_wake_epoch (id, since) VALUES (1, ${since})`;
  });

const ask = (world: World, path: string, expiresAt?: DateTime.Utc) =>
  Effect.gen(function* () {
    const run = (yield* world.orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    return yield* world.handoffs.create({
      kind: "approval",
      title: "Allow the change?",
      reason: "The agent needs a person.",
      requestedBy: { threadId, providerInstanceId: instanceId, path },
      target: { environmentId, path },
      runId: run.id,
      nodeId: run.rootNodeId!,
      human: { location: "PRIVATE-INSTRUCTIONS" },
      args: { path },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  });

const wakes = (world: World) =>
  world.orchestrator
    .getThreadProjection(threadId)
    .pipe(
      Effect.map((projection) =>
        projection.messages.filter((message) => message.id.startsWith("message:handoff-wake:")),
      ),
    );

/** The persisted update that resolved this handoff, as the reactor's stream delivers it. */
const resolution = (world: World, handoffId: string) =>
  world.orchestrator
    .streamStoredEventsFrom({ afterSequence: 0, eventType: "turn-item.updated" })
    .pipe(
      Stream.map((stored) => stored.event),
      Stream.filter(
        (event): event is OrchestrationV2DomainEvent =>
          event.type === "turn-item.updated" &&
          event.payload.type === "human_handoff" &&
          event.payload.handoff?.handoffId === handoffId &&
          event.payload.handoff.state === "completed",
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((events) => Array.from(events)[0]!),
    );

it.effect("wakes the asking thread once when a person answers, even while its run is active", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      const event = yield* resolution(world, summary.handoffId);
      yield* world.reactor.handle(event);
      yield* world.reactor.handle(event);
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.id).toBe(`message:handoff-wake:${summary.handoffId}:completed`);
      expect(sent[0]!.text).toContain("was approved by Laptop");
      expect(sent[0]!.text).not.toContain("PRIVATE-INSTRUCTIONS");
    }),
  ),
);

it.effect(
  "stays quiet when an approval expires with its run, so the agent does not ask again",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        yield* ask(world, "example.approve");
        yield* world.orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        yield* world.worker.drain();
        yield* world.handoffs.sweep;
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
      }),
    ),
);

it.effect("wakes once when a clocked handoff expires before a person answers", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
      yield* TestClock.adjust("31 minutes");
      yield* world.handoffs.sweep;
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent.map((message) => message.id)).toEqual([
        `message:handoff-wake:${summary.handoffId}:expired`,
      ]);
      expect(sent[0]!.text).toContain("Ask again only if the user still wants it");
    }),
  ),
);

it.effect("wakes nothing before waking began, or resolved before it began", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
      yield* TestClock.adjust("1 minute");
      yield* startEpoch(world);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
    }),
  ),
);
