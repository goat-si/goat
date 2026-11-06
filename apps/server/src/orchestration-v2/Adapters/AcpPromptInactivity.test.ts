import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "./AcpMockRuntime.testkit.ts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const makePromptInactivityHarness = Effect.fnUntraced(function* (input: {
  readonly environment: (runtimeOrdinal: number) => Readonly<Record<string, string>>;
  readonly runtimeMode?: "full-access" | "approval-required";
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const natives: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
  const instanceId = ProviderInstanceId.make("acp-prompt-inactivity");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      promptInactivityTimeout: "15 minutes",
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath: yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        ),
        environment: input.environment,
        wrapRuntime: (runtime) => {
          natives.push(runtime);
          return runtime;
        },
      }),
    },
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const threadId = ThreadId.make("thread-acp-prompt-inactivity");
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-inactivity"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const startTurn = (ordinal: number) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
        ),
      ),
    );
  return {
    runtime,
    natives,
    startTurn,
    /** A turn still running makes the next start fail, without waiting on time. */
    nextTurnRejected: (ordinal: number) =>
      startTurn(ordinal).pipe(
        Effect.flip,
        Effect.map(
          (error) =>
            isProviderAdapterProtocolError(error.cause) &&
            error.cause.reason === "previous_turn_active",
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      ),
    emitUpdate: (notification: EffectAcpSchema.SessionNotification) =>
      natives.at(-1)!.request("_test/emit-update", notification),
    terminals: (count: number) =>
      runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(count),
        Stream.runCollect,
        Effect.map((events) =>
          Array.from(events, (event) => {
            if (event.type !== "turn.terminal") throw new Error("Expected a turn terminal");
            return event;
          }),
        ),
      ),
  };
});

describe("ACP prompt inactivity", () => {
  it.effect("fails a prompt its agent leaves silent past the inactivity timeout", () =>
    Effect.gen(function* () {
      const harness = yield* makePromptInactivityHarness({
        environment: (runtimeOrdinal) =>
          runtimeOrdinal === 1 ? { GOAT_ACP_HANG_PROMPT_FOREVER: "1" } : {},
      });
      const thought = (sessionId: string) => ({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk" as const,
          content: { type: "text" as const, text: "Still working." },
        },
      });
      yield* harness.startTurn(1);
      yield* TestClock.adjust("10 minutes");
      yield* harness.emitUpdate(thought("mock-session-1"));
      yield* TestClock.adjust("5 minutes");
      // Neither another session's progress nor this session's metadata extends this turn.
      yield* harness.emitUpdate(thought("foreign-session"));
      yield* harness.emitUpdate({
        sessionId: "mock-session-1",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      });
      yield* TestClock.adjust(Duration.millis(10 * 60_000 - 1));
      assert.isTrue(yield* harness.nextTurnRejected(2));

      yield* TestClock.adjust("1 millis");
      yield* harness.startTurn(2);
      const [silent, next] = yield* harness.terminals(2);
      assert.equal(silent?.status, "failed");
      assert.include(silent?.failure?.message, "15 minutes");
      assert.equal(next?.status, "completed");
      assert.lengthOf(harness.natives, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "holds the inactivity timeout while a tool runs and restarts it when the tool ends",
    () =>
      Effect.gen(function* () {
        const harness = yield* makePromptInactivityHarness({
          environment: (runtimeOrdinal) =>
            runtimeOrdinal === 1
              ? { GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: "execute" }
              : {},
        });
        yield* harness.startTurn(1);
        yield* harness.runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call",
          ),
          Stream.runHead,
        );
        yield* TestClock.adjust("1 hour");
        assert.isTrue(yield* harness.nextTurnRejected(2));

        yield* harness.emitUpdate({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tracked-tool-call",
            status: "completed",
          },
        });
        yield* TestClock.adjust(Duration.millis(15 * 60_000 - 1));
        assert.isTrue(yield* harness.nextTurnRejected(2));
        yield* TestClock.adjust("1 millis");
        yield* harness.startTurn(2);
        const [silent, next] = yield* harness.terminals(2);
        assert.equal(silent?.status, "failed");
        assert.equal(next?.status, "completed");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("holds the inactivity timeout while the agent waits on an approval", () =>
    Effect.gen(function* () {
      const harness = yield* makePromptInactivityHarness({
        environment: () => ({ GOAT_ACP_EMIT_TOOL_CALLS: "1" }),
        runtimeMode: "approval-required",
      });
      yield* harness.startTurn(1);
      const pending = Option.getOrThrow(
        yield* harness.runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending approval");
      }
      // Only the request is left open, so it alone holds the deadline.
      yield* harness.emitUpdate({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-call-1",
          status: "completed",
        },
      });
      yield* TestClock.adjust("1 hour");
      assert.isTrue(yield* harness.nextTurnRejected(2));

      yield* harness.runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      const [approved] = yield* harness.terminals(1);
      assert.equal(approved?.status, "completed");
      assert.lengthOf(harness.natives, 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("fails a running prompt once when its agent process exits", () =>
    Effect.gen(function* () {
      const harness = yield* makePromptInactivityHarness({
        environment: (runtimeOrdinal) =>
          runtimeOrdinal === 1
            ? { GOAT_ACP_EMIT_TOOL_CALLS: "1" }
            : runtimeOrdinal === 2
              ? { GOAT_ACP_HANG_PROMPT_FOREVER: "1" }
              : {},
        runtimeMode: "approval-required",
      });
      yield* harness.startTurn(1);
      // The dying agent leaves an approval unanswered.
      yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        ),
        Stream.runHead,
      );
      yield* harness.natives[0]!.notify("_test/exit", {});
      const [exited] = yield* harness.terminals(1);
      assert.equal(exited?.status, "failed");

      // The replacement's silent prompt still times out.
      yield* harness.startTurn(2);
      yield* TestClock.adjust("15 minutes");
      yield* harness.startTurn(3);
      const [silent, next] = yield* harness.terminals(2);
      assert.equal(silent?.status, "failed");
      assert.notEqual(silent?.providerTurnId, exited?.providerTurnId);
      assert.equal(next?.status, "completed");
      assert.lengthOf(harness.natives, 3);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
