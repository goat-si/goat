import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import {
  readProviderReplayTranscript,
  materializeReplayTranscriptWorkspace,
} from "@goat/provider-testing/replayTranscript";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../src/persistence/Sqlite.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../src/orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../src/orchestration-v2/EffectWorker.ts";
import { CodexOrchestratorReplayHarness } from "../../src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { layerProviderReplay } from "../../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("benchmark-project");
export const replayThreadId = ThreadId.make("benchmark-replay");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };

export function createThread(threadId: ThreadId) {
  return {
    type: "thread.create" as const,
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId,
    title: `Generated benchmark ${threadId}`,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

export const seed = Effect.fn("benchmark.seed")(function* (input: {
  readonly dbPath: string;
  readonly workspace: string;
  readonly threads: number;
}) {
  const raw = yield* readProviderReplayTranscript(
    new URL(
      "../../src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson",
      import.meta.url,
    ),
  );
  const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptWorkspace(raw, input.workspace),
  );
  const databaseLayer = SqlitePersistence.layerFromPath(input.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const runtime = layerProviderReplay(
    {
      name: "responsiveness-benchmark",
      commands: [],
      transcript,
      runtimePolicyOverride: {
        cwd: input.workspace,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
    CodexOrchestratorReplayHarness,
    { databaseLayer },
  );
  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.commitProjectCommand({
      commandId: CommandId.make("benchmark-project-create"),
      projectId,
      commandType: "project.create",
      acceptedAt: now,
      event: {
        eventId: EventId.make("benchmark-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId: CommandId.make("benchmark-project-create"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Generated benchmark",
          workspaceRoot: input.workspace,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      },
    });
    for (let index = 0; index < input.threads; index++) {
      const threadId = ThreadId.make(`benchmark-seed-${index}`);
      yield* orchestrator.dispatch(createThread(threadId));
      yield* sink.write({
        events: (["user", "assistant"] as const).map((role) => ({
          id: EventId.make(`benchmark-history:${index}:${role}`),
          type: "message.updated" as const,
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`benchmark-history:${index}:${role}`),
            threadId,
            runId: null,
            nodeId: null,
            role,
            text:
              `Generated fixture ${index} ${role}: ` +
              Array.from({ length: 128 }, (_, token) =>
                ((index + 1) * (token + 17)).toString(36),
              ).join(" "),
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: role === "user" ? ("user" as const) : ("agent" as const),
            creationSource: role === "user" ? ("web" as const) : ("provider" as const),
          },
        })),
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`benchmark-seed-settle:${index}`),
        threadId,
      });
    }
    yield* orchestrator.dispatch(createThread(replayThreadId));
    const afterSequence = yield* orchestrator.getThreadEventSequence(replayThreadId);
    const completed = yield* orchestrator
      .streamStoredEventsFrom({ threadId: replayThreadId, afterSequence })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("benchmark-message"),
      threadId: replayThreadId,
      messageId: MessageId.make("benchmark-user-message"),
      text: "Respond with the following text: fixture simple ok",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* Fiber.join(completed);
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const projection = yield* orchestrator.getThreadProjection(replayThreadId);
    if (!projection.messages.some((message) => message.text === "fixture simple ok")) {
      return yield* Effect.die(new Error("Replay did not persist its expected answer"));
    }
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("benchmark-replay-settle"),
      threadId: replayThreadId,
    });
    const sql = yield* SqlClient.SqlClient;
    const counts = yield* sql<{
      events: number;
      messages: number;
      threads: number;
      sqliteVersion: string;
    }>`SELECT
        sqlite_version() AS sqliteVersion,
        (SELECT count(*) FROM orchestration_events) AS events,
        (SELECT count(*) FROM orchestration_v2_projection_messages) AS messages,
        (SELECT count(*) FROM orchestration_v2_projection_threads) AS threads`;
    return { counts: counts[0], replayTurns: projection.runs.length };
  }).pipe(Effect.provide(Layer.merge(runtime, databaseLayer)), Effect.scoped);
}, Effect.provide(NodeServices.layer));
