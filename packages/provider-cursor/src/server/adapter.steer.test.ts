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

const steerLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);
const firstPrompt = "Write me a 1000 word story about a dog.";
const steerText = "No wait, a pig please.";
const instructionsTag = "<t3_code_orchestration_instructions>";

const makeSteerHarness = Effect.gen(function* () {
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
  const startedTurn = (runOrdinal: number) =>
    runtime.events.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.runAttemptId === turnInput(runOrdinal, "").attemptId,
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const interruptRun = (runOrdinal: number, text: string) =>
    Effect.gen(function* () {
      yield* runtime.startTurn(turnInput(runOrdinal, text));
      const started = yield* startedTurn(runOrdinal);
      assert(started.type === "provider_turn.updated");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
    });
  const finishRun = (index: number) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(runEnds[index]!, "finished");
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal" && event.status === "completed"),
        Stream.runHead,
      );
    });
  return { runtime, turnInput, sentMessages, interruptRun, finishRun };
});

describe("CursorAdapterV2", () => {
  it.effect("carries an interrupted prompt into the steer that restarts the turn", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, sentMessages, interruptRun, finishRun } = yield* makeSteerHarness;

      yield* interruptRun(1, firstPrompt);
      yield* runtime.startTurn(turnInput(2, steerText));

      assert.lengthOf(sentMessages, 2);
      const steered = sentMessages[1]!;
      assert.include(steered, steerText);
      assert.include(
        steered,
        firstPrompt,
        "the interrupted prompt is missing from the run that replaces it",
      );
      assert.equal(
        steered.split(instructionsTag).length,
        2,
        "the steer must wrap its combined request once with the instructions the cancelled run carried",
      );
      assert(steered.startsWith(instructionsTag));

      yield* finishRun(1);
      yield* runtime.startTurn(turnInput(3, "Now a cow."));
      assert.notInclude(sentMessages[2]!, firstPrompt, "a finished turn carries nothing forward");
    }).pipe(Effect.scoped, Effect.provide(steerLayer)),
  );

  it.effect("wraps a steer that keeps the interrupted run's ordinal once", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, sentMessages, interruptRun } = yield* makeSteerHarness;

      yield* interruptRun(1, firstPrompt);
      yield* runtime.startTurn(turnInput(1, steerText));

      assert.lengthOf(sentMessages, 2);
      const steered = sentMessages[1]!;
      assert.include(steered, firstPrompt);
      assert.include(steered, steerText);
      assert.equal(steered.split(instructionsTag).length, 2);
      assert(steered.startsWith(instructionsTag));
    }).pipe(Effect.scoped, Effect.provide(steerLayer)),
  );

  it.effect("adds no instructions to a steer of an interrupted later run", () =>
    Effect.gen(function* () {
      const { runtime, turnInput, sentMessages, interruptRun, finishRun } = yield* makeSteerHarness;
      const secondPrompt = "Now write one about a cat.";

      yield* runtime.startTurn(turnInput(1, firstPrompt));
      yield* finishRun(0);
      yield* interruptRun(2, secondPrompt);
      yield* runtime.startTurn(turnInput(3, steerText));

      assert.lengthOf(sentMessages, 3);
      const steered = sentMessages[2]!;
      assert.include(steered, secondPrompt);
      assert.include(steered, steerText);
      assert.notInclude(steered, firstPrompt);
      assert.notInclude(steered, instructionsTag);
      assert(steered.startsWith("Your previous turn was interrupted"));
    }).pipe(Effect.scoped, Effect.provide(steerLayer)),
  );
});
