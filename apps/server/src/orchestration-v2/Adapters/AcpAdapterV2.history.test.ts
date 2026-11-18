import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DocumentText from "../../provider/DocumentText.ts";
import { bundledMockAgentPath, makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = Layer.mergeAll(
  nodeLayer,
  DocumentText.layer.pipe(Layer.provide(nodeLayer)),
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(nodeLayer)),
);

const openReplay = Effect.fn(function* () {
  type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let update: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
  const instanceId = ProviderInstanceId.make("acp-history");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    selfInvocation: yield* resolveSelfInvocation(),
    flavor: {
      driver: ProviderDriverKind.make("acp-test"),
      capabilities: AcpProviderCapabilitiesV2,
      makeRuntime: makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath: yield* bundledMockAgentPath,
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              update = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
        }),
      }),
    },
  });
  const threadId = ThreadId.make("thread-acp-history");
  const modelSelection = { instanceId, model: "default" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    modelSelection,
    runtimePolicy,
    providerSessionId: ProviderSessionId.make("session-acp-history"),
    historyImport: true,
  });
  const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  assert.isDefined(update);
  return { update: update!, snapshot: runtime.readThreadSnapshot({ providerThread: thread }) };
});

it.effect.each(["bytes", "messages"] as const)("refuses a replay exceeding the %s limit", (limit) =>
  Effect.gen(function* () {
    const { update, snapshot } = yield* openReplay();
    const text = limit === "bytes" ? "é".repeat(65_536) : "entry";
    const count = limit === "bytes" ? 256 : 200;
    const send = (index: number) =>
      update({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate:
            limit === "messages" && index % 2 === 1 ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    for (let index = 0; index < count; index++) yield* send(index);
    const atLimit = yield* snapshot;
    assert.equal(atLimit.messages.length, limit === "bytes" ? 1 : count);
    if (limit === "bytes") assert.equal(atLimit.messages[0]?.text.length, 16 * 1024 * 1024);
    yield* send(count);
    const result = yield* Effect.result(snapshot);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.propertyVal(result.failure, "historyLimitExceeded", true);
    }
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
