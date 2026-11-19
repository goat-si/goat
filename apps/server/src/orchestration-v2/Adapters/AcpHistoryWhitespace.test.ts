import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { bundledMockAgentPath, makeMockRuntime } from "./AcpMockRuntime.testkit.ts";
import { ACP_TEST_DRIVER, layerTest } from "./AcpAdapterV2.host.testkit.ts";

it.effect("preserves separators in replay while omitting blank messages", () =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const selfInvocation = yield* resolveSelfInvocation();
    const mockAgentPath = yield* bundledMockAgentPath;
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let handler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
    const instanceId = ProviderInstanceId.make("acp-whitespace-test");
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeMockRuntime({
          childProcessSpawner,
          mockAgentPath,
          wrapRuntime: (runtime) => ({
            ...runtime,
            handleSessionUpdate: (next) =>
              Effect.sync(() => {
                handler = next;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
          }),
        }),
      },
      selfInvocation,
    });
    const threadId = ThreadId.make("thread-acp-whitespace-test");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("acp-whitespace-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    assert.isDefined(handler);
    const replay = (messageId: string, text: string) =>
      handler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text },
        },
      });
    yield* replay("message-1", "hello");
    yield* replay("message-1", " ");
    yield* replay("message-1", "world");
    yield* replay("blank", "\n\n");
    yield* handler!({
      sessionId: "mock-session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "blank-thought",
        content: { type: "text", text: "  " },
      },
    });
    yield* handler!({
      sessionId: "mock-session-1",
      update: {
        sessionUpdate: "agent_message",
        messageId: "image",
        content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      },
    });
    const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
    assert.deepEqual(
      snapshot.messages.map((message) => message.text),
      ["hello world", "[ACP image (image/png)]"],
    );
    assert.deepEqual(snapshot.reasoningMessageIds, []);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
