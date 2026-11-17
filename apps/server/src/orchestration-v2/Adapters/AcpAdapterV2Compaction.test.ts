import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolPromptTextBlocks,
  bundledMockAgentPath,
} from "./AcpMockRuntime.testkit.ts";

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

const makeAdvertisedCompactionHarness = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string>>,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selfInvocation = yield* resolveSelfInvocation();
  const mockAgentPath = yield* bundledMockAgentPath;
  const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
  // Resolves after the adapter records what the agent advertised, so the refusal is deterministic.
  const commandsPublished = yield* Deferred.make<void>();
  const instanceId = ProviderInstanceId.make("acp-test-advertised-compaction");
  const threadId = ThreadId.make("thread-acp-advertised-compaction");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      compactViaAdvertisedCommand: true,
      onAvailableCommandsUpdate: () => Deferred.succeed(commandsPublished, undefined),
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        environment,
      }),
    },
    selfInvocation,
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-advertised-compaction"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  yield* Deferred.await(commandsPublished);
  const now = yield* DateTime.now;
  let ordinal = 0;
  const nextPromptTexts = () =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(protocolEvents);
        if (event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt") {
          return rawProtocolPromptTextBlocks(event);
        }
      }
    });
  return {
    runtime,
    compact: (otherSession = false) =>
      Effect.gen(function* () {
        const compactThread = runtime.compactThread;
        if (compactThread === undefined) return yield* Effect.die("compactThread is not wired");
        return yield* Effect.exit(
          compactThread(
            makeTurnInput({
              threadId,
              providerThread: otherSession
                ? {
                    ...providerThread,
                    nativeThreadRef: {
                      driver: ACP_TEST_DRIVER,
                      nativeId: "other-session",
                      strength: "strong",
                    },
                  }
                : { ...providerThread, contextUsage: { usedTokens: 1234 } },
              instanceId,
              runtimePolicy,
              now,
              ordinal: ++ordinal,
              messageText: "Compact the conversation.",
            }),
          ),
        );
      }),
    nextPromptTexts,
  };
});

describe("ACP compaction through an advertised command", () => {
  it.live.each([false, true])(
    "sends a bare /compact prompt with protocol compaction %s",
    (structured) =>
      Effect.gen(function* () {
        const harness = yield* makeAdvertisedCompactionHarness({
          GOAT_ACP_AVAILABLE_COMMANDS: "compact,plan",
          GOAT_ACP_COMPACTION_PROMPT_ORDINALS: structured ? "1" : "",
        });
        const compacted = yield* harness.compact();
        assert.isTrue(Exit.isSuccess(compacted));
        assert.deepEqual(yield* harness.nextPromptTexts(), [{ type: "text", text: "/compact" }]);
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.contextUsage === null,
          ),
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "compaction" &&
              event.turnItem.status === "completed" &&
              event.turnItem.title === (structured ? "Compact context" : "Context compacted"),
          ),
        );
        assert.lengthOf(
          events.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "compaction" &&
              event.turnItem.status === "completed",
          ),
          1,
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live.each([
    { active: "plan", target: "compact", allowed: true },
    { active: "compact", target: "plan", allowed: false },
    { active: "compact", target: undefined, allowed: false },
  ])(
    "validates the target session's compact command ($active -> $target)",
    ({ active, target, allowed }) =>
      Effect.gen(function* () {
        const harness = yield* makeAdvertisedCompactionHarness({
          GOAT_ACP_AVAILABLE_COMMANDS: active,
          ...(target === undefined ? {} : { GOAT_ACP_LOADED_COMMANDS: target }),
        });
        const result = yield* harness.compact(true);
        assert.equal(Exit.isSuccess(result), allowed);
        if (allowed) {
          assert.deepEqual(yield* harness.nextPromptTexts(), [{ type: "text", text: "/compact" }]);
          yield* harness.runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runDrain,
          );
        } else {
          const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined;
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(
            (error as ProviderAdapter.ProviderAdapterTurnStartError).cause,
            ProviderAdapter.ProviderCompactionUnsupportedError,
          );
        }
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
