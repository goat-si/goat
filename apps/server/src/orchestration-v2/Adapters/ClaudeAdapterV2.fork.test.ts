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
import * as SecureRandom from "effect/crypto/SecureRandom";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the fork fixture places a real Claude transcript.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
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
  it.effect("forks a session from its original directory after the workspace root changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-v2-fork-attachments-",
        });
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-root-change-",
        });
        const sourceSessionId = "11111111-1111-4111-8111-111111111111";
        const sourceCursor = "aaaaaaaa-0000-4000-8000-000000000002";
        const projectDir = NodePath.join(configDir, "projects", "-old-workspace");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });
        const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
          type: parentUuid === null ? "user" : "assistant",
          uuid,
          parentUuid,
          sessionId: sourceSessionId,
          cwd: "/old-workspace",
          isSidechain: false,
          timestamp: "2026-10-01T00:00:00.000Z",
          message,
        });
        yield* fileSystem.writeFileString(
          NodePath.join(projectDir, `${sourceSessionId}.jsonl`),
          [
            entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
            entry(sourceCursor, "aaaaaaaa-0000-4000-8000-000000000001", {
              role: "assistant",
              content: [{ type: "text", text: "inherited answer" }],
            }),
          ]
            .map((line) => JSON.stringify(line))
            .join("\n"),
        );
        const realRunner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.pipe(
          Effect.provide(
            ClaudeAdapterV2.layerQueryRunner.pipe(
              Layer.provide(
                Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
                  native: undefined,
                  canonical: undefined,
                }),
              ),
            ),
          ),
        );
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed(sourceSessionId),
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
              Effect.gen(function* () {
                forkCalls.push(input);
                return yield* realRunner.forkSession(input);
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
                nativeId: sourceCursor,
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
            sessionId: sourceSessionId,
            options: {
              upToMessageId: sourceCursor,
            },
            environment: { CLAUDE_CONFIG_DIR: configDir },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        const forkedSessionId = forkedProviderThread.nativeThreadRef?.nativeId;
        assert.isString(forkedSessionId);
        assert.notEqual(forkedSessionId, sourceSessionId);
        const forkedTranscript = yield* fileSystem.readFileString(
          NodePath.join(projectDir, `${forkedSessionId}.jsonl`),
        );
        assert.include(forkedTranscript, "inherited answer");
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

        assert.equal(openedQueries[0]?.options.resume, forkedSessionId);
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
        assert.equal(openedQueries[0]?.options.cwd, NodePath.resolve("/workspace"));
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
