import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");
const mockAgentPath = Effect.flatMap(Path.Path, (path) =>
  path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
);

describe("AcpAdapterV2 session updates", () => {
  it.live("keeps a completed tool's status when its linked ACP terminal streams output", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("acp-test-terminal-linked-tool");
      const threadId = ThreadId.make("thread-acp-terminal-linked-tool");
      let notify: Parameters<
        AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]
      >[0];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  notify = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    notify({ sessionId: "mock-session-1", update });
                  yield* send({ sessionUpdate: "state_update", state: "running" });
                  yield* send({
                    sessionUpdate: "terminal_update",
                    terminalId: "term",
                    command: "npm run dev",
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "linked",
                    kind: "execute",
                    title: "Start dev server",
                    status: "completed",
                    content: [{ type: "terminal", terminalId: "term" }],
                  });
                  yield* send({
                    sessionUpdate: "terminal_output_chunk",
                    terminalId: "term",
                    data: Buffer.from("still running").toString("base64"),
                  });
                  yield* send({
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-terminal-linked-tool"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 1,
        }),
      );
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === "linked"
          ? [event.turnItem]
          : [],
      );
      const last = items.at(-1);
      assert.equal(last?.type === "command_execution" ? last.output : null, "still running");
      assert.deepEqual(
        items.map((item) => item.status),
        items.map(() => "completed"),
        "terminal output must not reopen a tool the agent completed",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
