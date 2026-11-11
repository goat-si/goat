import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerProjectServiceTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  modelSelection,
} from "../runtimeLayer.testkit.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as RunStartHoldReactor from "./RunStartHoldReactor.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const AT = "2026-11-10T00:00:00.000Z";
const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "codex-record" };

/** A thread whose Codex start admission the test holds: by survivors, or by stop fences. */
const heldThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`start-hold-${name}`);
    const projectId = ProjectId.make(`start-hold-${name}-project`);
    yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
      projects.apply({
        sequence: 0,
        eventId: EventId.make(`seed:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: AT,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Held",
          workspaceRoot: `/workspace/${name}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      }),
    );
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`start-hold-${name}-create`),
      threadId,
      projectId,
      title: "Held",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const bindings = yield* Ref.make<ReadonlyArray<CodexSurvivors.CodexSurvivorBinding>>([]);
    const stopFenced = yield* Ref.make<ReadonlyArray<string>>([]);
    const fenceChanged = yield* Ref.make<Option.Option<Effect.Effect<void>>>(Option.none());
    const survivors = Layer.mock(CodexSurvivors.CodexSurvivors)({
      list: Ref.get(bindings),
      onFenceChange: (effect) => Ref.set(fenceChanged, Option.some(effect)),
      startBlockedThreads: Effect.all([Ref.get(bindings), Ref.get(stopFenced)]).pipe(
        Effect.map(([held, fenced]) => [
          ...held.map((binding) => binding.threadId),
          ...(fenced.length > 0 ? [threadId] : []),
        ]),
      ),
      getStopObligations: (id) =>
        Ref.get(stopFenced).pipe(
          Effect.map((turns) =>
            id === threadId
              ? turns.map((nativeTurnId) => ({
                  record,
                  block: { threadId, nativeThreadId: "native-thread", nativeTurnId },
                }))
              : [],
          ),
        ),
    });
    const send = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`start-hold-${name}-${text}`),
        threadId,
        messageId: MessageId.make(`start-hold-${name}-${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
    /** The first time a run reaches a state; the thread's events replay from the start. */
    const runReaches = (predicate: (run: OrchestrationV2Run) => boolean) =>
      Stream.unwrap(Effect.map(EventSink.EventSinkV2, (sink) => sink.stream({ threadId }))).pipe(
        Stream.flatMap((stored) =>
          (stored.event.type === "run.created" || stored.event.type === "run.updated") &&
          predicate(stored.event.payload)
            ? Stream.make(stored.event.payload)
            : Stream.empty,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    const startReactor = RunStartHoldReactor.make.pipe(
      Effect.tap((reactor) => reactor.start),
      Effect.provide(Layer.merge(survivors, NodeServices.layer)),
    );
    return {
      orchestrator,
      threadId,
      bindings,
      stopFenced,
      fenceChanged,
      send,
      runReaches,
      startReactor,
    };
  });

it.layer(layerTest)("RunStartHoldReactor", (it) => {
  it.effect(
    "a run held behind a turn no run owns names that turn until the run stops waiting",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* heldThread("unowned");
          yield* Ref.set(held.stopFenced, ["goal-turn"]);
          yield* held.startReactor;
          yield* held.send("first");
          const marked = yield* held.runReaches((run) => run.startHold !== undefined);
          assert.strictEqual(marked.status, "starting");
          assert.deepStrictEqual(marked.startHold, {
            reason: "unowned_turn",
            nativeTurnId: "goal-turn",
          });
          yield* held.orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("start-hold-unowned-stop"),
            threadId: held.threadId,
          });
          const released = yield* held.runReaches(
            (run) =>
              run.id === marked.id && run.status !== "starting" && run.startHold === undefined,
          );
          assert.strictEqual(released.status, "interrupted");
        }),
      ),
  );

  it.effect(
    "a run already waiting behind a restart survivor is marked when the server activates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* heldThread("survivor");
          yield* Ref.set(held.bindings, [
            {
              ...record,
              threadId: held.threadId,
              sourceRunId: RunId.make("run-before-restart"),
              nativeThreadId: "native-thread",
              nativeTurnId: "survivor-turn",
            },
          ]);
          yield* held.send("queued-before-activation");
          const waiting = yield* held.runReaches((run) => run.status === "starting");
          assert.isUndefined(waiting.startHold);
          yield* held.startReactor;
          const marked = yield* held.runReaches((run) => run.startHold !== undefined);
          assert.strictEqual(marked.id, waiting.id);
          assert.deepStrictEqual(marked.startHold, {
            reason: "restart_survivor",
            nativeTurnId: "survivor-turn",
          });
        }),
      ),
  );

  it.effect("after the shown turn stops, reconciling names the turn that still holds the run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const held = yield* heldThread("next-turn");
        yield* Ref.set(held.stopFenced, ["first-turn", "second-turn"]);
        const reactor = yield* held.startReactor;
        yield* held.send("waits-for-two");
        const first = yield* held.runReaches((run) => run.startHold !== undefined);
        assert.strictEqual(first.startHold?.nativeTurnId, "first-turn");
        // The fence of the first turn goes without any run event, as after a stop.
        yield* Ref.set(held.stopFenced, ["second-turn"]);
        yield* reactor.reconcileThread(held.threadId);
        const next = yield* held.runReaches((run) => run.startHold?.nativeTurnId === "second-turn");
        assert.strictEqual(next.id, first.id);
      }),
    ),
  );

  it.effect(
    "a fence that clears on its own re-points the hold to the turn still holding the run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const held = yield* heldThread("natural-clear");
          yield* Ref.set(held.stopFenced, ["first-turn", "second-turn"]);
          yield* held.startReactor;
          yield* held.send("waits-for-two");
          const first = yield* held.runReaches((run) => run.startHold !== undefined);
          assert.strictEqual(first.startHold?.nativeTurnId, "first-turn");
          // The first turn ends by itself: its fence clears with no run event and no person's stop.
          yield* Ref.set(held.stopFenced, ["second-turn"]);
          const changed = yield* Ref.get(held.fenceChanged);
          assert.isTrue(Option.isSome(changed), "the reactor must follow fence changes");
          yield* Option.getOrThrow(changed);
          const next = yield* held.runReaches(
            (run) => run.startHold?.nativeTurnId === "second-turn",
          );
          assert.strictEqual(next.id, first.id);
        }),
      ),
  );
});
