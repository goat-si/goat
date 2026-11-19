// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  makeAcpAdapterV2,
} from "@goat/provider-acp/server/adapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

it.live("Stop closes an MCP-over-ACP call stalled on its SSE response", () =>
  Effect.gen(function* () {
    const responseStarted = yield* Deferred.make<void>();
    const responseClosed = yield* Deferred.make<void>();
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve) => {
            const server = NodeHttp.createServer((_request, response) => {
              response.on("close", () => Deferred.doneUnsafe(responseClosed, Effect.void));
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
              Deferred.doneUnsafe(responseStarted, Effect.void);
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die("Expected a TCP address");
    }
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let mcpConnect: Parameters<RuntimeService["handleMcpConnect"]>[0] | undefined;
    let mcpMessage: Parameters<RuntimeService["handleMcpMessage"]>[0] | undefined;
    const instanceId = ProviderInstanceId.make("acp-test-stop-mcp-call");
    const threadId = ThreadId.make("thread-acp-stop-mcp-call");
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make("environment-acp-stop-mcp-call"),
      threadId,
      providerSessionId: "mcp-session-acp-stop-mcp-call",
      providerInstanceId: instanceId,
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      authorizationHeader: "Bearer stop-mcp-call-token",
      browserToolsAvailable: false,
    });
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        interruptPromptOnCancel: true,
        makeRuntime: makeMockRuntime({
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          mockAgentPath: yield* bundledMockAgentPath,
          environment: { GOAT_ACP_HANG_PROMPT_FOREVER: "1" },
          wrapRuntime: (runtime) => ({
            ...runtime,
            handleMcpConnect: (handler) =>
              Effect.sync(() => {
                mcpConnect = handler;
              }).pipe(Effect.andThen(runtime.handleMcpConnect(handler))),
            handleMcpMessage: (handler) =>
              Effect.sync(() => {
                mcpMessage = handler;
              }).pipe(Effect.andThen(runtime.handleMcpMessage(handler))),
          }),
        }),
      },
      selfInvocation: yield* resolveSelfInvocation(),
      clientTerminals: {},
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-acp-stop-mcp-call"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
    });
    const turnFiber = yield* runtime
      .startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      )
      .pipe(Effect.forkScoped);
    if (mcpConnect === undefined || mcpMessage === undefined) {
      return yield* Effect.die("ACP runtime must register MCP-over-ACP handlers");
    }
    const { connectionId } = yield* mcpConnect(
      { serverId: "goat" },
      { requestId: "stop-mcp-connect", method: "mcp/connect" },
    );
    const call = yield* mcpMessage(
      { connectionId, method: "tools/call", params: { name: "task_status", arguments: {} } },
      { requestId: "stop-mcp-call", method: "mcp/message" },
    ).pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(responseStarted);

    yield* runtime.interruptTurn({
      providerThread,
      providerTurnId: idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      }),
    });
    assert.isTrue(Exit.isFailure(yield* Fiber.join(call)));
    yield* Deferred.await(responseClosed);
    yield* Fiber.join(turnFiber);
  }).pipe(Effect.provide(layerTest)),
);
