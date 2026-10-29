import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { unusedRegistry } from "./CodexAdapterV2.attachment.testkit.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});

it.effect(
  "preserves Claude's live query by installing the changed credential before the next turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("goat-bot-session:claude:1");
        const nativeSessionId = "session-credential-native";
        const modelSelection = {
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          model: "claude-sonnet-4-6",
        };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const config: McpProviderSession.McpProviderSessionConfig = {
          environmentId: EnvironmentId.make("fixture"),
          threadId,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: "credential-a",
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer fixture-a",
          browserToolsAvailable: false,
          grantedScopes: [],
        };
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-session-",
        });
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const offers: SDKUserMessage[] = [];
        const operations: string[] = [];
        const servers: Array<Record<string, unknown>> = [];
        let opens = 0;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(nativeSessionId),
            open: (input) =>
              Effect.sync(() => {
                expect(input.options.disallowedTools).toEqual(["Agent", "Task"]);
                opens++;
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: (message) =>
                    Effect.sync(() => {
                      offers.push(message);
                      operations.push("offer");
                    }),
                  setMcpServers: (value) =>
                    Effect.sync(() => {
                      servers.push(value);
                      operations.push("setMcpServers");
                    }),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        }).pipe(Effect.provideService(McpSessionRegistry.McpSessionRegistry, unusedRegistry));
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(config);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("claude-session"),
          modelSelection,
          runtimePolicy,
        });
        const terminals = yield* Queue.unbounded<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const turn = (ordinal: number): ProviderAdapter.ProviderAdapterV2TurnInput => ({
          appThread: {
            id: threadId,
            title: "Session credential",
            projectId: ProjectId.make("fixture-project"),
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
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
          },
          threadId,
          providerThread,
          runId: RunId.make("run-" + ordinal),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make("attempt-" + ordinal),
          rootNodeId: NodeId.make("node-" + ordinal),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-" + ordinal),
            text: "turn-" + ordinal,
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turn(1));
        const first = offers[0];
        expect(first).toBeDefined();
        yield* Queue.offer(sdkMessages, { ...first!, session_id: nativeSessionId });
        yield* Queue.offer(sdkMessages, {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "fixture",
            iterations: [],
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-4000-8000-000000000123",
          session_id: nativeSessionId,
          terminal_reason: "completed",
        });
        yield* Queue.take(terminals);
        yield* sessions.set({
          ...config,
          providerSessionId: "credential-b",
          authorizationHeader: "Bearer fixture-b",
        });
        yield* runtime.startTurn(turn(2));
        expect(opens).toBe(1);
        expect(operations).toEqual(["offer", "setMcpServers", "offer"]);
        expect(JSON.stringify(servers)).toContain("Bearer fixture-b");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          IdAllocator.layer,
          McpProviderSessions.layer,
          MemoryDerivedCache.layer,
        ),
      ),
    ),
);
