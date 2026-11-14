import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { goalHarness, nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

it.effect("restarts by stopping the running turn when the provider cannot interrupt-restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } = yield* goalHarness(
        "restart-without-interrupt-restart",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: started[0]!.runId },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "do this instead"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a restart that stops the running turn ahead of an older held queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn, send, read } =
        yield* goalHarness("restart-past-held-queue");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        yield* worker.drain();
        const secondRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("second"),
          threadId,
          messageId: MessageId.make("message:second"),
          text: "second",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(secondRunning);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          dispatchMode: { type: "restart_active", targetRunId: started[1]!.runId },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();

        const { queue, started: startedTexts } = yield* read(threadId);
        assert.deepEqual(
          { queue, started: startedTexts },
          { queue: ["queued"], started: ["first", "second", "do this instead"] },
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("reports a restart that stops the running turn as restarted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* goalHarness("restart-send-delivery");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadManagement = yield* ThreadManagementService.ThreadManagementService;
        const threadId = yield* startFirstTurn;
        const input = {
          projectId: ProjectId.make("project:restart-send-delivery"),
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "do this instead",
          attachments: [],
          mode: "restart",
          createdBy: "agent",
          creationSource: "mcp",
        } as const;
        const sent = yield* threadManagement.sendToThread(input);
        // Stop holds the replacement before it starts; a replay must still report the restart.
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-after-restart"),
          threadId,
        });
        const replayed = yield* threadManagement.sendToThread(input);

        assert.equal(started.length, 1);
        assert.deepEqual([sent.delivery, replayed.delivery], ["restarted", "restarted"]);
      }).pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provideMerge(layer),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        ),
      );
    }),
  ),
);

it.effect.each(["auto", "steer"] as const)(
  "reports a stopping goal consistently on %s replay",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `goal-send-${mode}`;
        const { layer, startFirstTurn } = yield* goalHarness(name);
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const service = yield* ThreadManagementService.ThreadManagementService;
          const input = {
            projectId: ProjectId.make(`project:${name}`),
            commandId: CommandId.make("goal"),
            threadId,
            messageId: MessageId.make("message:goal"),
            text: "/goal ship it",
            attachments: [],
            mode,
            createdBy: "agent",
            creationSource: "mcp",
          } as const;
          const sent = yield* service.sendToThread(input);
          const replayed = yield* service.sendToThread(input);
          assert.deepEqual([sent.delivery, replayed.delivery], ["queued", "queued"]);
        }).pipe(
          Effect.provide(
            ThreadManagementService.layer.pipe(
              Layer.provideMerge(layer),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
          ),
        );
      }),
    ),
);

it.effect.each(["supportsInterrupt", "supportsQueuedMessages"] as const)(
  "rejects restart without %s and creates no replacement work",
  (missing) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `restart-no-${missing}`;
        const { layer, startFirstTurn, interrupted, started } = yield* nextTurnSelectionHarness(
          name,
          false,
          Effect.void,
          false,
          undefined,
          true,
          { [missing]: false },
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const service = yield* ThreadManagementService.ThreadManagementService;
          const failure = yield* Effect.flip(
            service.sendToThread({
              projectId: ProjectId.make(`project:${name}`),
              commandId: CommandId.make("restart"),
              threadId,
              messageId: MessageId.make("message:restart"),
              text: "replacement",
              attachments: [],
              mode: "restart",
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );
          assert.include(String(failure.cause), "interrupt_restart_steering");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs.length, 1);
          assert.isFalse(
            projection.turnItems.some((item) => item.type === "run_interrupt_request"),
          );
          assert.deepEqual(interrupted, []);
          assert.equal(started.length, 1);
        }).pipe(
          Effect.provide(
            ThreadManagementService.layer.pipe(
              Layer.provideMerge(layer),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
          ),
        );
      }),
    ),
);
