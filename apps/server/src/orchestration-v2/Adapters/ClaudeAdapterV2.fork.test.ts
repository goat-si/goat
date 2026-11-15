import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const layerAdapterTest = layerClaudeAdapterTest;

describe("ClaudeAdapterV2 native fork", () => {
  it.effect("forks at the source assistant cursor and resumes the forked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-v2-fork-attachments-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("source-native-session"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: (input) =>
              Effect.sync(() => {
                forkCalls.push(input);
                return { sessionId: "forked-native-session" };
              }),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const providerSessionId = ProviderSessionId.make("provider-session-claude-fork");
        const sourceThreadId = ThreadId.make("thread-claude-fork-source");
        const targetThreadId = ThreadId.make("thread-claude-fork-target");
        const runtime = yield* adapter.openSession({
          threadId: sourceThreadId,
          providerSessionId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const sourceProviderThread = yield* runtime.ensureThread({
          threadId: sourceThreadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("provider-turn-claude-source");
        const forkedProviderThread = yield* runtime.forkThread({
          sourceProviderThread,
          sourceProviderTurns: [
            {
              id: providerTurnId,
              providerThreadId: sourceProviderThread.id,
              nodeId: NodeId.make("node-claude-source"),
              runAttemptId: RunAttemptId.make("run-attempt-claude-source"),
              nativeTurnRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "assistant-message-cursor",
                strength: "weak",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurnId,
          targetThreadId,
        });

        assert.deepEqual(forkCalls, [
          {
            sessionId: "source-native-session",
            options: {
              dir: "/workspace",
              upToMessageId: "assistant-message-cursor",
            },
            environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "forked-native-session");
        assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, providerTurnId);

        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: targetThreadId,
            projectId: ProjectId.make("project-claude-fork-target"),
            title: "Claude fork target",
            providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: forkedProviderThread.id,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: targetThreadId,
          runId: RunId.make("run-claude-fork-target"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt-claude-fork-target"),
          rootNodeId: NodeId.make("node-claude-fork-target-root"),
          providerThread: forkedProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-fork-target"),
            text: "Respond with fork ok",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });

        assert.equal(openedQueries[0]?.options.resume, "forked-native-session");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
