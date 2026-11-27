import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  withMessageSenderNote,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { nextTurnSelectionHarness } from "./testkit/SteeringHarness.ts";
const driver = ProviderDriverKind.make("codex");

it.effect("replays an accepted steer after its target turn completes", () =>
  Effect.gen(function* () {
    const name = "steer-retry-after-completion";
    const { events, started, steered, layer, startFirstTurn } =
      yield* nextTurnSelectionHarness(name);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const threadId = yield* startFirstTurn;
      const input = {
        projectId: ProjectId.make(`project:${name}`),
        commandId: CommandId.make("steer"),
        threadId,
        messageId: MessageId.make("message:steer"),
        text: "Please report the test result",
        attachments: [],
        mode: "steer",
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const accepted = yield* threadManagement.sendToThread(input);
      assert.equal(accepted.delivery, "steered");
      yield* worker.drain();

      const waiting = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === accepted.run.id &&
            event.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
      const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: accepted.run.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(waiting);
      yield* worker.drain();

      const replayed = yield* threadManagement.sendToThread(input);
      assert.equal(replayed.dispatch.replayed, true);
      assert.equal(replayed.delivery, accepted.delivery);
      assert.equal(replayed.message.id, accepted.message.id);
      assert.equal(replayed.run.id, accepted.run.id);
      assert.equal(replayed.run.status, "completed");

      const fresh = yield* threadManagement
        .sendToThread({
          ...input,
          commandId: CommandId.make("fresh-steer"),
          messageId: MessageId.make("message:fresh-steer"),
        })
        .pipe(Effect.flip);
      assert.equal(fresh._tag, "ThreadManagementNoSteerableRunError");
      yield* worker.drain();
      assert.deepEqual(steered, [withMessageSenderNote(input, input.text)]);
      assert.lengthOf(started, 1);
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
);
