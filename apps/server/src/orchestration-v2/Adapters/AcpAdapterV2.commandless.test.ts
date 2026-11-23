import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

it.effect("leaves command_execution input empty when the tool call carries no command", () =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const selfInvocation = yield* resolveSelfInvocation();
    const mockAgentPath = yield* bundledMockAgentPath;
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
    const promptStarted = yield* Deferred.make<void>();
    const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const instanceId = ProviderInstanceId.make("acp-test-empty-command-input");
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
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdateHandler = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            prompt: () =>
              Deferred.succeed(promptStarted, undefined).pipe(
                Effect.andThen(Deferred.await(promptGate)),
              ),
          }),
        }),
      },
      selfInvocation,
    });
    const threadId = ThreadId.make("thread-acp-empty-command-input");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-acp-empty-command-input"),
      modelSelection,
      runtimePolicy,
    });
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    yield* runtime.startTurn(
      makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
    );
    yield* Deferred.await(promptStarted);

    const sessionId = "mock-session-1";
    yield* sessionUpdateHandler!({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-exec-no-cmd",
        title: "Run command",
        kind: "execute",
        status: "in_progress",
        rawInput: {},
      },
    });
    yield* sessionUpdateHandler!({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-monitor-no-cmd",
        title: "Monitor",
        kind: "other",
        status: "in_progress",
        rawInput: { variant: "monitor" },
      },
    });
    yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });

    const commandItems: Array<{
      readonly nativeId: string | null | undefined;
      readonly status: string;
      readonly input: string;
    }> = [];
    let terminal = false;
    while (!terminal) {
      const event = yield* Queue.take(events);
      if (event.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
        commandItems.push({
          nativeId: event.turnItem.nativeItemRef?.nativeId,
          status: event.turnItem.status,
          input: event.turnItem.input,
        });
      }
      if (event.type === "turn.terminal") {
        terminal = true;
      }
    }

    assert.deepEqual(commandItems, [
      { nativeId: "call-exec-no-cmd", status: "running", input: "" },
      { nativeId: "call-monitor-no-cmd", status: "running", input: "" },
      { nativeId: "call-exec-no-cmd", status: "completed", input: "" },
      { nativeId: "call-monitor-no-cmd", status: "completed", input: "" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);
