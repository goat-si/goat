import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  it.effect("carries an interrupted prompt into the steer that restarts the turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-steer-" });
      const sentMessages: Array<string> = [];
      const runEnds: Array<Deferred.Deferred<"finished" | "cancelled">> = [];
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-steer-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
        settings: yield* decodeCursorSettings({}),
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-steer",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  const runId = `native-cursor-run-${sentMessages.length}`;
                  const ended = yield* Deferred.make<"finished" | "cancelled">();
                  runEnds.push(ended);
                  return {
                    agentId: "native-cursor-steer",
                    runId,
                    // Cursor drops a cancelled run's prompt from the agent's conversation.
                    wait: Deferred.await(ended).pipe(
                      Effect.map((status) => ({
                        id: runId,
                        requestId: `native-request-${sentMessages.length}`,
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      })),
                    ),
                    cancel: Deferred.succeed(ended, "cancelled"),
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-steer-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-steer-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor steer",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const turnInput = (runOrdinal: number, text: string) => ({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make(`cursor-steer-run-${runOrdinal}`),
        runOrdinal,
        providerTurnOrdinal: runOrdinal,
        attemptId: RunAttemptId.make(`cursor-steer-attempt-${runOrdinal}`),
        rootNodeId: NodeId.make(`cursor-steer-root-${runOrdinal}`),
        appThread,
        message: {
          messageId: MessageId.make(`cursor-steer-message-${runOrdinal}`),
          createdBy: "user" as const,
          creationSource: "web" as const,
          text,
          attachments: [],
        },
      });
      const firstPrompt = "Write me a 1000 word story about a dog.";
      const steerText = "No wait, a pig please.";

      yield* runtime.startTurn(turnInput(1, firstPrompt));
      const started = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        ),
      );
      assert(started.type === "provider_turn.updated");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      yield* runtime.startTurn(turnInput(2, steerText));

      assert.lengthOf(sentMessages, 2);
      const steered = sentMessages[1]!;
      assert.include(steered, steerText);
      assert.include(
        steered,
        firstPrompt,
        "the interrupted prompt is missing from the run that replaces it",
      );

      yield* Deferred.succeed(runEnds[1]!, "finished");
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal" && event.status === "completed"),
        Stream.runHead,
      );
      yield* runtime.startTurn(turnInput(3, "Now a cow."));
      assert.notInclude(sentMessages[2]!, firstPrompt, "a finished turn carries nothing forward");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
