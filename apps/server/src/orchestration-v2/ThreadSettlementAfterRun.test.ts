import { expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, type OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

// The agent reads a message steered in after it asked to settle and ends on a question.
it.effect.each(["steer", "promoted_queued_to_steer"] as const)(
  "settleAfterRun keeps the thread open after a %s read once the settle was requested",
  (inputIntent) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:settle-after-steer");
      const threadId = ThreadId.make("thread:thread-management:settle-after-steer");
      const runId = RunId.make("run:thread-management:settle-after-steer");
      yield* TestClock.adjust(Duration.millis(60_000));
      const dispatched: Array<string> = [];
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            restartContinuationPending: () => Effect.succeed(false),
            streamStoredEventsFrom: () => Stream.empty,
            getThreadRecords: () =>
              Effect.succeed({
                thread: { id: threadId, projectId, deletedAt: null },
                runs: [{ id: runId, ordinal: 1, status: "completed", userMessageId: "original" }],
                messages: [
                  { id: "original", runId, role: "user" },
                  { id: "steered", runId, role: "user" },
                ],
                turnItems: [
                  {
                    runId,
                    type: "user_message",
                    inputIntent,
                    status: "completed",
                    createdAt: "1970-01-01T00:01:30.000Z",
                    completedAt: "1970-01-01T00:01:30.000Z",
                  },
                ],
              } as unknown as OrchestrationV2ThreadProjection),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.type);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );
      yield* service.settleAfterRun({ projectId, threadId, runId });
      expect(dispatched).toEqual([]);
    }),
);
