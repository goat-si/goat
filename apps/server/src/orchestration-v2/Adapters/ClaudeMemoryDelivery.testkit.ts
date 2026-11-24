import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ProviderSessionId } from "@goat/contracts";
import * as M from "@goat/contracts";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
} from "./ClaudeTestInput.testkit.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

export const wp4Memory = () => {
  const snapshot = MemoryContext.packMemoryContext({
    memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: M.MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: M.MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: M.EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <untrusted> 'quoted' \"data\"",
      },
    ],
  });
  if (!snapshot) throw new Error("fixture memory could not be packed");
  return snapshot;
};

export const liveClaudeQueryFixture = Effect.fn("claudeTest.liveQueryFixture")(function* (
  config: McpProviderSession.McpProviderSessionConfig,
  nativeSessionId: string,
  currentMemoryPolicy: McpSessionRegistry.McpSessionRegistry["Service"]["currentMemoryPolicy"] = () =>
    Effect.undefined,
  interruptCloses = false,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `goat-${config.threadId}-`,
  });
  const offers: SDKUserMessage[] = [];
  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
  const registrations: Array<Record<string, unknown>> = [];
  const opened: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions[] = [];
  let closes = 0;
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings: DEFAULT_CLAUDE_SETTINGS,
    environment: {},
    attachmentsDir,
    fileSystem,
    path: yield* Path.Path,
    random: yield* SecureRandom.SecureRandom,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: {
      allocateSessionId: Effect.succeed(nativeSessionId),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
          return {
            messages: Stream.fromQueue(sdkMessages),
            offer: (message) =>
              Effect.sync(() => {
                offers.push(message);
              }),
            setMcpServers: (servers) =>
              Effect.sync(() => {
                registrations.push(servers);
              }),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: interruptCloses ? Queue.shutdown(sdkMessages) : Effect.void,
            close: Effect.sync(() => void closes++),
          } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  }).pipe(
    Effect.provideService(McpSessionRegistry.McpSessionRegistry, {
      issue: () => Effect.die("unused"),
      resolve: () => Effect.undefined,
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeAll: Effect.void,
      subscribeChanges: Effect.die("unused"),
      inspect: () => Effect.undefined,
      currentMemoryPolicy,
    }),
  );
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  yield* sessions.set(config);
  const runtime = yield* adapter.openSession({
    threadId: config.threadId,
    providerSessionId: ProviderSessionId.make(`${config.threadId}-session`),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const terminals = yield* Queue.unbounded<void>();
  const approvalRequested = yield* Deferred.make<void>();
  const toolStarted = yield* Deferred.make<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => {
      if (event.type === "turn_item.updated" && event.turnItem.type === "command_execution")
        return Deferred.succeed(toolStarted, undefined);
      if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending")
        return Deferred.succeed(approvalRequested, undefined);
      return event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void;
    }),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: config.threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const finish = Effect.fn("claudeTest.finishLiveTurn")(function* (
    message: SDKUserMessage,
    uuid: SDKResultMessage["uuid"],
    beforeResult: ReadonlyArray<SDKMessage> = [],
  ) {
    yield* Queue.offer(sdkMessages, { ...message, session_id: nativeSessionId });
    for (const frame of beforeResult) yield* Queue.offer(sdkMessages, frame);
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
      uuid,
      session_id: nativeSessionId,
      terminal_reason: "completed",
    });
  });
  return {
    offers,
    registrations,
    opened,
    sessions,
    runtime,
    providerThread,
    terminals,
    approvalRequested,
    toolStarted,
    emit: (message: SDKMessage) => Queue.offer(sdkMessages, message),
    finish,
    get closes() {
      return closes;
    },
  };
});
