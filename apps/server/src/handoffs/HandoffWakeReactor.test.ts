import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  PROVIDER_SETTINGS_HANDOFF_PATH,
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
import * as Fiber from "effect/Fiber";
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
const resolution = (world: World, handoffId: string, state: HandoffState = "completed") =>
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
      Effect.map((events) => Array.from(events)[0]!),
    );

const waitForComputerUse = (
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

it.effect("consumes an approval in the waiting turn and keeps later reconciles quiet", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "completed" },
        consumed: true,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect("consumes an earlier approval and cancels its wake queued behind the asking turn", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      const event = yield* resolution(world, summary.handoffId);
      yield* world.reactor.handle(event);
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      const wakeRun = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === sent[0]!.id,
      );
      expect(wakeRun?.status).toBe("queued");
      const answer = yield* world.handoffs.awaitComputerUseAnswer(
        {
          threadId,
          handoffId: summary.handoffId,
          until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
        },
        () => Effect.succeed(true),
      );
      expect(answer).toMatchObject({ handoff: { state: "completed" }, consumed: true });
      for (const deliver of [world.reactor.handle(event), world.reactor.reconcile]) {
        yield* deliver;
        expect(yield* wakes(world)).toHaveLength(1);
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.userMessageId === sent[0]!.id,
        );
        expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
      }
    }),
  ),
);

it.effect(
  "an answer whose queued wake cannot be withdrawn still reaches the call and keeps that wake",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
        const sent = yield* wakes(world);
        expect(sent).toHaveLength(1);
        world.outage.failWithdraw = true;
        const answer = yield* world.handoffs.awaitComputerUseAnswer(
          {
            threadId,
            handoffId: summary.handoffId,
            until: DateTime.add(yield* DateTime.now, { minutes: 1 }),
          },
          () => Effect.succeed(true),
        );
        expect(answer).toMatchObject({ handoff: { state: "completed" }, consumed: true });
        // Nothing recorded the answer as taken, so the thread keeps the wake it was sent.
        world.outage.failWithdraw = false;
        yield* world.reactor.reconcile;
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs.filter(
          (run) => run.userMessageId === sent[0]!.id,
        );
        expect(runs.map((run) => run.status)).toEqual(["queued"]);
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect("a repeated decline keeps a decline the waiting call already returned quiet", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 1 }),
      );
      const decline = world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      yield* decline;
      expect(yield* Fiber.join(waiting)).toMatchObject({ consumed: true });
      // A client retrying the same answer must not clear the record of it.
      yield* decline;
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect.each(["declined", "cancelled"] as const)(
  "consumes a person's %s answer in the waiting turn without waking it",
  (action) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(yield* DateTime.now, { minutes: 1 }),
        );
        yield* world.handoffs.respond({ threadId, handoffId: summary.handoffId, action }, person);
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: action, actor: { type: "client" } },
          consumed: true,
        });
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId, action));
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(0);
      }),
    ),
);

it.effect(
  "leaves a request pending when its wait budget ends and wakes once on later approval",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const now = yield* DateTime.now;
        const summary = yield* ask(
          world,
          COMPUTER_USE_GRANT_HANDOFF_PATH,
          DateTime.add(now, { minutes: 5 }),
        );
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(now, { minutes: 1 }),
        );
        yield* TestClock.adjust("2 minutes");
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: "pending" },
          consumed: false,
        });
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
        expect(yield* wakes(world)).toHaveLength(1);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(1);
      }),
    ),
);

it.effect("wakes once when the asking turn cannot consume an answer it waited for", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(yield* DateTime.now, { minutes: 1 }),
        false,
      );
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "completed" },
        consumed: false,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(1);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
    }),
  ),
);

it.effect("consumes expiry before the wait budget without waking another turn", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const now = yield* DateTime.now;
      const summary = yield* ask(
        world,
        COMPUTER_USE_GRANT_HANDOFF_PATH,
        DateTime.add(now, { minutes: 1 }),
      );
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(now, { minutes: 5 }),
      );
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        handoff: { state: "expired" },
        consumed: true,
      });
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId, "expired"));
      expect(yield* wakes(world)).toHaveLength(0);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(0);
    }),
  ),
);

it.effect("releases an interrupted waiter's answer so a later approval wakes once", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
      const waiting = yield* waitForComputerUse(
        world,
        summary.handoffId,
        DateTime.add(yield* DateTime.now, { minutes: 1 }),
      );
      yield* Fiber.interrupt(waiting);
      expect((yield* Fiber.await(waiting))._tag).toBe("Failure");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      expect(yield* wakes(world)).toHaveLength(1);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toHaveLength(1);
    }),
  ),
);

it.effect(
  "a different computer use request cancels the older waiting request as the agent without waking",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH);
        const waiting = yield* waitForComputerUse(
          world,
          summary.handoffId,
          DateTime.add(yield* DateTime.now, { minutes: 1 }),
        );
        const run = (yield* world.orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const newer = yield* world.handoffs.create({
          kind: "approval",
          title: "Allow a different app?",
          reason: "The agent needs a different app.",
          requestedBy: {
            threadId,
            providerInstanceId: instanceId,
            path: COMPUTER_USE_GRANT_HANDOFF_PATH,
          },
          target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "PRIVATE-INSTRUCTIONS" },
          args: { path: COMPUTER_USE_GRANT_HANDOFF_PATH, apps: ["com.apple.TextEdit"] },
        });
        expect(newer.handoffId).not.toBe(summary.handoffId);
        expect((yield* world.handoffs.read({ threadId, handoffId: newer.handoffId })).state).toBe(
          "pending",
        );
        expect(yield* Fiber.join(waiting)).toMatchObject({
          handoff: { state: "cancelled", actor: { type: "agent" } },
          consumed: true,
        });
        yield* world.reactor.handle(yield* resolution(world, summary.handoffId, "cancelled"));
        expect(yield* wakes(world)).toHaveLength(0);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toHaveLength(0);
      }),
    ),
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
      expect(sent[0]!.text).toContain("was approved by a person");
      expect(sent[0]!.text).not.toContain("Laptop");
      expect(sent[0]!.text).not.toContain("PRIVATE-INSTRUCTIONS");
    }),
  ),
);

it.effect("tells the agent to continue an approved hub change through goat_call", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "hub.device_join");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      const sent = yield* wakes(world);
      expect(sent[0]!.text).toContain(
        `Call goat_call {path:"hub.device_join"} again with decisionId "${summary.handoffId}"`,
      );
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

// #1521: a card's Stop ends the thread's grant. Waking the agent about it started a new turn,
// which took the screen again and replaced the stopped card.
it.effect(
  "stays quiet when a person ends an approved computer use grant, but not a pending request",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        const pending = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: pending.handoffId, action: "cancelled" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* world.reactor.reconcile;
        const sent = yield* wakes(world);
        expect(sent.map((message) => message.id).sort()).toEqual(
          [
            `message:handoff-wake:${approved.handoffId}:completed`,
            `message:handoff-wake:${pending.handoffId}:cancelled`,
          ].sort(),
        );
        // The approval's wake waited behind the thread's running turn; ending the grant withdrew
        // it, so it never starts a turn that takes the screen again.
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs;
        const approvalWake = runs.find(
          (run) => run.userMessageId === `message:handoff-wake:${approved.handoffId}:completed`,
        );
        expect(approvalWake?.status).toBe("cancelled");
      }),
    ),
);

it.effect(
  "a late approval event or a repeated end still wakes no agent whose grant a person ended",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        const approval = yield* resolution(world, approved.handoffId);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        // The approval's event reaches the reactor only now, after the end.
        yield* world.reactor.handle(approval);
        // A second end of the same grant, as a repeated Stop sends.
        yield* world.handoffs
          .respond({ threadId, handoffId: approved.handoffId, action: "cancelled" }, person)
          .pipe(Effect.ignore);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
      }),
    ),
);

it.effect(
  "interrupts an approval wake that started its turn only after a person ended the grant",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* TestClock.adjust("1 second");
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        // Before the reactor hears of the end, the thread's turn ends and the wake starts.
        yield* TestClock.adjust("1 second");
        yield* world.orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-first"),
          threadId,
        });
        yield* world.worker.drain();
        const wake = `message:handoff-wake:${approved.handoffId}:completed`;
        yield* world.orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-queue"),
          threadId,
        });
        yield* world.worker.drain();
        const started = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === wake,
        );
        expect(["running", "waiting", "starting"]).toContain(started?.status);
        yield* world.reactor.reconcile;
        yield* world.worker.drain();
        const after = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === wake,
        );
        expect(after?.status).toBe("interrupted");
      }),
    ),
);

it.effect(
  "stays quiet when a person ends an approved computer use grant whose approval wake failed",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        world.outage.failing = 1;
        yield* world.reactor.reconcile;
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        yield* TestClock.adjust("20 minutes");
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
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

it.effect(
  "walks past command ids the orchestrator rejected before a restart and delivers at once",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, "example.approve");
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        // A long planning failure left rejected receipts under the first 25 command ids.
        const first = `server:handoff-wake:${summary.handoffId}:completed`;
        for (let attempt = 0; attempt < 25; attempt++)
          yield* world.sql`INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
          VALUES (${attempt === 0 ? first : `${first}:attempt:${attempt}`}, 'thread', ${threadId},
          'message.dispatch', '2026-10-23T00:00:00.000Z', 0, 'rejected', 'adapter unavailable')`;
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(26);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(26);
        expect((yield* wakes(world)).map((message) => message.id)).toEqual([
          `message:handoff-wake:${summary.handoffId}:completed`,
        ]);
      }),
    ),
);

it.effect("makes one fresh attempt per eligible tick, waiting longer after each failure", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // Fourteen failures run the backoff past its 15-minute cap.
      world.outage.failing = 14;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      for (let attempt = 1; attempt < 14; attempt++) {
        const delayMs = Math.min(2 ** attempt * 1000, 15 * 60 * 1000);
        yield* TestClock.adjust(delayMs - 1);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(attempt);
        yield* TestClock.adjust(1);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(attempt + 1);
        expect(world.outage.sent.at(-1)).toMatch(new RegExp(`:attempt:${attempt}$`));
      }
      expect(yield* wakes(world)).toEqual([]);
      yield* TestClock.adjust("15 minutes");
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(15);
      expect((yield* wakes(world)).map((message) => message.id)).toEqual([
        `message:handoff-wake:${summary.handoffId}:completed`,
      ]);
    }),
  ),
);

it.effect("reads the day's resolved handoffs through their index, not the whole history", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* world.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
        SELECT turn_item_id FROM orchestration_v2_projection_turn_items AS item
        WHERE item.type = 'human_handoff' AND item.status <> 'waiting'
          AND item.updated_at >= '2026-10-22T00:00:00.000Z'`;
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "orchestration_v2_projection_turn_items_resolved_handoff_idx (updated_at>?)",
      );
    }),
  ),
);

it.effect("counts the backoff from when a slow attempt failed", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // The first attempt takes three seconds to fail, longer than its two-second backoff.
      world.outage.failing = 2;
      world.outage.slowMs = 3000;
      const first = yield* Effect.forkChild(world.reactor.reconcile);
      yield* Deferred.await(world.outage.arrived);
      yield* TestClock.adjust(3000);
      yield* Fiber.join(first);
      world.outage.slowMs = 0;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      yield* TestClock.adjust(1999);
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(2);
    }),
  ),
);

it.effect(
  "wakes after GOAT finishes applying an approved provider change, saying how it ended",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, PROVIDER_SETTINGS_HANDOFF_PATH);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        // Approved but not yet applied: an idle thread woken now would see no change and ask again.
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
        yield* world.handoffs.finishProviderContinuation(
          { threadId, handoffId: summary.handoffId },
          {
            version: 1,
            effects: { install: "started" },
            outcome: {
              state: "unknown_outcome",
              effect: "install",
              reason: "orchestration_error",
              message: "The install did not answer.",
              reconcile: { call: "goat_provider_diagnose", arguments: { instanceId: "cursor-2" } },
            },
          },
        );
        yield* world.reactor.reconcile;
        yield* world.reactor.reconcile;
        const sent = yield* wakes(world);
        expect(sent.map((message) => message.id)).toEqual([
          `message:handoff-wake:${summary.handoffId}:completed`,
        ]);
        expect(sent[0]!.text).toContain(
          'Call goat_call {path:"provider.diagnose", args:{"instanceId":"cursor-2"}} to settle it',
        );
      }),
    ),
);

it.effect("wakes after an approved provider sync settles, with how each host ended", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "provider.host_sync");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // Installing on the hosts: an idle thread woken now would see nothing installed yet.
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
      yield* world.handoffs.finishProviderContinuation(
        { threadId, handoffId: summary.handoffId },
        {
          syncId: "sync-1",
          result: {
            syncId: "sync-1",
            driver: "codex",
            version: null,
            login: false,
            startedAt: "2026-10-23T00:00:00.000Z",
            done: true,
            hosts: [
              { host: null, phase: "installed", version: "0.163.0" },
              { host: "box", phase: "failed", version: null, message: "The installer exited 1." },
            ],
          },
        },
      );
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain(
        "The sync finished on 1 of 2 host(s). box: failed (The installer exited 1.).",
      );
    }),
  ),
);
