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
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const makePromptInactivityHarness = Effect.fnUntraced(function* (input: {
  readonly environment: (runtimeOrdinal: number) => Readonly<Record<string, string>>;
  readonly runtimeMode?: "full-access" | "approval-required";
  readonly wrapPrompt?: (
    prompt: AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"];
  readonly cancelled?: Deferred.Deferred<void>;
  readonly followAgentWorkState?: boolean;
  readonly recognizedBackground?: boolean;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const natives: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
  const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
  const instanceId = ProviderInstanceId.make("acp-prompt-inactivity");
  const mockRuntime = makeMockRuntime({
    childProcessSpawner,
    mockAgentPath: yield* bundledMockAgentPath,
    environment: input.environment,
    wrapRuntime: (runtime) => {
      natives.push(runtime);
      return {
        ...runtime,
        prompt: input.wrapPrompt?.(runtime.prompt) ?? runtime.prompt,
        cancel:
          input.cancelled === undefined
            ? runtime.cancel
            : Deferred.succeed(input.cancelled, undefined).pipe(Effect.andThen(runtime.cancel)),
      };
    },
  });
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      promptInactivityTimeout: "15 minutes",
      ...(input.followAgentWorkState === true ? { followAgentWorkState: true } : {}),
      ...(input.recognizedBackground === true
        ? {
            extractBackgroundTaskId: (tool: { readonly toolCallId: string }) =>
              tool.toolCallId === "tracked-tool-call" ? "background-task" : undefined,
          }
        : {}),
      makeRuntime: (runtimeInput) => {
        runtimeInputs.push(runtimeInput);
        return mockRuntime(runtimeInput);
      },
    },
    selfInvocation: yield* resolveSelfInvocation(),
    ...(input.followAgentWorkState === true
      ? { continuationRequests: { offer: () => Effect.void } }
      : {}),
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
    runtimeInputs,
    providerThread,
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
  it.effect.each([false, true])(
    "ends a running tool when the ACP process dies (followAgentWorkState: %s)",
    (followAgentWorkState) =>
      Effect.gen(function* () {
        const harness = yield* makePromptInactivityHarness({
          followAgentWorkState,
          environment: (ordinal) =>
            ordinal === 1 ? { GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: "execute" } : {},
        });
        yield* harness.startTurn(1);
        let exited = false;
        const statuses = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call"
              ? Stream.make(event.turnItem.status)
              : Stream.empty,
          ),
          Stream.tap(() =>
            exited
              ? Effect.void
              : Effect.sync(() => (exited = true)).pipe(
                  Effect.andThen(harness.natives[0]!.notify("_test/exit", {})),
                ),
          ),
          Stream.runCollect,
          Effect.map((collected) => Array.from(collected)),
        );
        assert.include(["failed", "interrupted", "cancelled"], statuses.at(-1));
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([false, true])(
    "fails a pending tool when a live ACP agent rejects its prompt (followAgentWorkState: %s)",
    (followAgentWorkState) =>
      Effect.gen(function* () {
        const harness = yield* makePromptInactivityHarness({
          followAgentWorkState,
          environment: (ordinal) =>
            ordinal === 1
              ? {
                  GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: "execute",
                  GOAT_ACP_FAIL_PROMPT: "1",
                }
              : {},
        });
        yield* harness.startTurn(1);
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
        );
        const statuses = events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call"
            ? [event.turnItem.status]
            : [],
        );
        assert.equal(statuses.at(-1), "failed");
        assert.notInclude(["pending", "running"], statuses.at(-1));
        const failed = events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call" &&
            event.turnItem.status === "failed",
        );
        assert.include(
          JSON.stringify(failed),
          "The ACP agent rejected the prompt before the tool finished.",
        );
        const terminal = events.at(-1);
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
        if (terminal?.type === "turn.terminal" && terminal.status === "failed")
          assert.isNotEmpty(terminal.failure.message);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([false, true])(
    "keeps a started tool running after a live ACP prompt rejection (followAgentWorkState: %s)",
    (followAgentWorkState) =>
      Effect.gen(function* () {
        const rejected = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makePromptInactivityHarness({
          followAgentWorkState,
          environment: (ordinal) =>
            ordinal === 1
              ? {
                  GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: "execute",
                  GOAT_ACP_FAIL_PROMPT: "1",
                }
              : {},
          wrapPrompt: (prompt) => (payload, options) =>
            prompt(payload, options).pipe(
              Effect.catchTags({
                AcpRequestError: (error) =>
                  Deferred.succeed(rejected, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Effect.fail(error)),
                  ),
              }),
            ),
        });
        yield* harness.startTurn(1);
        yield* Deferred.await(rejected);
        yield* harness.emitUpdate({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tracked-tool-call",
            status: "in_progress",
            rawOutput: { text: "kept-result" },
          },
        });
        yield* harness.runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call" &&
              event.turnItem.status === "running",
          ),
          Stream.runHead,
        );
        yield* Deferred.succeed(release, undefined);
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
        );
        const failed = events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call" &&
            event.turnItem.status === "failed",
        );
        assert.lengthOf(failed, 0);
        const terminal = events.at(-1);
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
        if (terminal?.type === "turn.terminal" && terminal.status === "failed")
          assert.isNotEmpty(terminal.failure.message);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "leaves a recognized background tool to its background lifecycle on prompt rejection",
    () =>
      Effect.gen(function* () {
        const harness = yield* makePromptInactivityHarness({
          recognizedBackground: true,
          environment: (ordinal) =>
            ordinal === 1
              ? {
                  GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: "execute",
                  GOAT_ACP_FAIL_PROMPT: "1",
                }
              : {},
        });
        yield* harness.startTurn(1);
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
        );
        const statuses = events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call"
            ? [event.turnItem.status]
            : [],
        );
        assert.include(statuses, "pending");
        assert.notInclude(statuses, "failed");
        const terminal = events.at(-1);
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

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

  // regression: #34160 a turn failed as silent right after the computer woke from sleep
  it.effect.each([
    { label: "a timer due during sleep fires on wake", timerCountsSleep: true, asleep: "2 hours" },
    { label: "the host wakes before the deadline", timerCountsSleep: true, asleep: "9 minutes" },
    {
      label: "timers pause while only wall time jumps",
      timerCountsSleep: false,
      asleep: "2 hours",
    },
  ] as const)(
    "does not count host sleep as prompt inactivity when $label",
    ({ timerCountsSleep, asleep }) =>
      Effect.gen(function* () {
        const testClock = yield* TestClock.testClockWith(Effect.succeed);
        const awake = yield* Latch.make(true);
        let wallJumpMillis = 0;
        // macOS and Windows timers count sleep and fire on the first tick after wake; on Linux
        // timers pause while the wall clock jumps.
        const hostClock: TestClock.TestClock = {
          ...testClock,
          currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe() + wallJumpMillis,
          currentTimeMillis: Effect.sync(
            () => testClock.currentTimeMillisUnsafe() + wallJumpMillis,
          ),
          sleep: (duration) => testClock.sleep(duration).pipe(Effect.andThen(awake.await)),
        };
        yield* Effect.gen(function* () {
          const harness = yield* makePromptInactivityHarness({
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { GOAT_ACP_HANG_PROMPT_FOREVER: "1" } : {},
          });
          yield* harness.startTurn(1);
          yield* TestClock.adjust("5 minutes");
          yield* harness.emitUpdate({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Still working." },
            },
          });
          if (timerCountsSleep) {
            yield* awake.close;
            yield* TestClock.adjust(asleep);
            yield* awake.open;
          } else {
            wallJumpMillis = Duration.toMillis(asleep);
          }
          yield* TestClock.adjust(Duration.millis(15 * 60_000 - 1));
          assert.isTrue(yield* harness.nextTurnRejected(2));

          yield* TestClock.adjust("2 minutes");
          yield* harness.startTurn(2);
          const [silent, next] = yield* harness.terminals(2);
          assert.equal(silent?.status, "failed");
          assert.equal(next?.status, "completed");
        }).pipe(Effect.provideService(Clock.Clock, hostClock));
      }).pipe(Effect.provide(layerTest)),
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

  it.effect.each(["tracked-first", "overflow-first"] as const)(
    "resumes the inactivity timeout after requests settle (%s)",
    (order) =>
      Effect.gen(function* () {
        const harness = yield* makePromptInactivityHarness({
          environment: (ordinal) => (ordinal === 1 ? { GOAT_ACP_HANG_PROMPT_FOREVER: "1" } : {}),
        });
        yield* harness.startTurn(1);
        const input = harness.runtimeInputs[0];
        if (!input?.onIncomingRequest || !input.onOutgoingResponse)
          return yield* Effect.die("Missing request callbacks");
        const incoming = input.onIncomingRequest;
        const outgoing = input.onOutgoingResponse;
        for (let index = 0; index < 1025; index++) yield* incoming(`request-${index}`, "test", {});
        yield* TestClock.adjust("15 minutes");
        assert.isTrue(yield* harness.nextTurnRejected(2));
        if (order === "overflow-first") yield* outgoing("request-1024");
        for (let index = 0; index < (order === "overflow-first" ? 1023 : 1024); index++) {
          yield* outgoing(`request-${index}`);
        }
        yield* TestClock.adjust("15 minutes");
        assert.isTrue(yield* harness.nextTurnRejected(2));
        yield* outgoing(order === "overflow-first" ? "request-1023" : "request-1024");
        yield* TestClock.adjust("15 minutes");
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

  it.effect("delivers a follow-up the agent rejects while it is still processing", () =>
    Effect.gen(function* () {
      let promptCalls = 0;
      const rejected = yield* Deferred.make<void>();
      const harness = yield* makePromptInactivityHarness({
        environment: () => ({}),
        // pi-agent-core based agents (oh-my-pi) end a turn but keep background work running.
        wrapPrompt: (prompt) => (payload, options) => {
          promptCalls += 1;
          return promptCalls === 2
            ? Deferred.succeed(rejected, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
                    ),
                  ),
                ),
              )
            : prompt(payload, options);
        },
      });
      yield* harness.startTurn(1);
      const [first] = yield* harness.terminals(1);
      assert.equal(first?.status, "completed");

      const followUp = yield* harness.terminals(1).pipe(Effect.forkScoped);
      yield* harness.startTurn(2);
      yield* Deferred.await(rejected);
      yield* TestClock.adjust("1 minute");
      const [delivered] = yield* Fiber.join(followUp);
      assert.equal(delivered?.status, "completed");
      assert.equal(promptCalls, 3);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("sends no more prompts once a follow-up waiting on a busy agent is stopped", () =>
    Effect.gen(function* () {
      let promptCalls = 0;
      const rejected = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const harness = yield* makePromptInactivityHarness({
        environment: () => ({}),
        cancelled,
        wrapPrompt: (prompt) => (payload, options) => {
          promptCalls += 1;
          return promptCalls === 1
            ? prompt(payload, options)
            : Deferred.succeed(rejected, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
                    ),
                  ),
                ),
              );
        },
      });
      yield* harness.startTurn(1);
      yield* harness.terminals(1);

      const stopped = yield* harness.terminals(1).pipe(Effect.forkScoped);
      yield* harness.startTurn(2);
      yield* Deferred.await(rejected);
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(
          ProviderInstanceId.make("acp-prompt-inactivity"),
          "mock-session-1:turn:2",
        ),
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(cancelled);
      yield* TestClock.adjust("1 second");
      const [terminal] = yield* Fiber.join(stopped);
      yield* Fiber.join(interrupt);
      assert.equal(terminal?.status, "interrupted");
      assert.equal(promptCalls, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
