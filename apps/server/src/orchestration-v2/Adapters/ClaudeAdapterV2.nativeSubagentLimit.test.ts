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
const CAP = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";

const subagentPolicy = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) => {
  const flagSettings =
    typeof options.settings === "object" && options.settings !== null ? options.settings : {};
  return {
    disallowedTools: options.disallowedTools,
    flagCap: (flagSettings as { env?: Record<string, string> }).env?.[CAP],
    processCap: options.env?.[CAP],
  };
};

it.effect(
  "holds Claude's native subagents to the thread's goatclaw limit and reopens Claude when it changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-claude-native-subagent-limit");
        const nativeSessionId = "native-subagent-limit-native";
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
          prefix: "goat-claude-subagent-limit-",
        });
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const offers: SDKUserMessage[] = [];
        const opened: Array<ReturnType<typeof subagentPolicy>> = [];
        const flagSettings: unknown[] = [];
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
                opened.push(subagentPolicy(input.options));
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: (message) => Effect.sync(() => void offers.push(message)),
                  setMcpServers: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: (value) => Effect.sync(() => void flagSettings.push(value)),
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
        const runTurn = (
          ordinal: number,
          nativeSubagentLimit: number | undefined,
          claudeCodeVersion = "2.1.304",
        ) =>
          Effect.gen(function* () {
            yield* sessions.set(
              nativeSubagentLimit === undefined ? config : { ...config, nativeSubagentLimit },
            );
            yield* runtime.startTurn(turn(ordinal));
            yield* Queue.offer(sdkMessages, {
              type: "system",
              subtype: "init",
              claude_code_version: claudeCodeVersion,
              permissionMode: "bypassPermissions",
              session_id: nativeSessionId,
              uuid: `00000000-0000-4000-8000-00000000011${ordinal}`,
            } as unknown as SDKMessage);
            const offer = offers.at(-1);
            expect(offer).toBeDefined();
            yield* Queue.offer(sdkMessages, { ...offer!, session_id: nativeSessionId });
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
              uuid: `00000000-0000-4000-8000-00000000012${ordinal}`,
              session_id: nativeSessionId,
              terminal_reason: "completed",
            });
            yield* Queue.take(terminals);
          });

        yield* runTurn(1, 3);
        yield* runTurn(2, 3);
        yield* runTurn(3, 0);
        yield* runTurn(4, undefined);
        // Claude Code before 2.1.217 ignores the cap, so that process keeps Agent off instead.
        yield* runTurn(5, 2, "2.1.200");
        expect(flagSettings).toEqual([{ permissions: { deny: ["Agent", "Task"] } }]);
        // Once seen, the old CLI's next process opens with Agent off.
        yield* runTurn(6, 2, "2.1.200");
        expect(opened).toEqual([
          { disallowedTools: undefined, flagCap: "3", processCap: "3" },
          { disallowedTools: ["Agent", "Task"], flagCap: undefined, processCap: undefined },
          { disallowedTools: undefined, flagCap: undefined, processCap: undefined },
          { disallowedTools: undefined, flagCap: "2", processCap: "2" },
          { disallowedTools: ["Agent", "Task"], flagCap: undefined, processCap: undefined },
        ]);
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
