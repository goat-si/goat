import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId, RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue))
          yield* capture((marker) => actual.offer(queue, marker));
        return yield* actual.take(queue);
      }),
  };
});

const setup = (resumed = false) =>
  Effect.gen(function* () {
    const queue = yield* Ref.make<Queue.Queue<SDKMessage> | undefined>(undefined);
    const controller = new AbortController();
    const harness = yield* makeWakeHarnessWithOptions({
      interrupt: Effect.sync(() => controller.abort()).pipe(
        Effect.andThen(Ref.get(queue)),
        Effect.flatMap((current) =>
          current === undefined ? Effect.void : Queue.shutdown(current),
        ),
      ),
    });
    yield* Ref.set(queue, harness.sdkMessages);
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const attemptId = RunAttemptId.make("watchdog-wait");
    const input = makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId,
      nativeThreadHasTurns: resumed,
      text: "Hello",
      attachments: [],
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    });
    yield* harness.runtime.startTurn(input);
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "command_lifecycle",
        command_uuid: harness.promptUuid(0),
        state: "started",
        uuid: "00000000-0000-4000-8000-000000000901",
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
    const stop = harness.runtime.interruptTurn({
      providerThread: harness.providerThread,
      providerTurnId: allocator.derive.providerTurn({
        driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
        nativeTurnId: `turn:${attemptId}`,
      }),
    });
    return { harness, controller, input, allocator, attemptId, stop };
  });

it.effect("a held early assistant response keeps a long turn alive and Stop interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, stop } = yield* setup();
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "00000000-0000-4000-8000-000000000902", text: "Working" }),
      );
      yield* TestClock.adjust("11 minutes");
      assert.isEmpty(harness.terminalEvents());
      yield* stop;
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect.each(["permission", "question", "elicitation", "exit-plan"] as const)(
  "a %s user wait stays alive and Stop interrupts it",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { harness, controller, stop } = yield* setup();
        const options = harness.getOpenedOptions();
        if (kind === "exit-plan") {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "assistant",
              message: {
                model: "claude-sonnet-4-6",
                id: "held-plan",
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "tool-plan",
                    name: "ExitPlanMode",
                    input: { plan: "A plan" },
                  },
                ],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
              parent_tool_use_id: null,
              uuid: "00000000-0000-4000-8000-000000000903",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        const pending =
          kind === "elicitation"
            ? yield* Effect.promise(() =>
                options!.onElicitation!(
                  {
                    serverName: "deploy",
                    message: "Allow?",
                    mode: "form",
                    requestedSchema: { type: "object", properties: {} },
                  },
                  { signal: controller.signal, requestId: "request-elicit" },
                ),
              ).pipe(Effect.forkScoped)
            : yield* Effect.promise(() =>
                options!.canUseTool!(
                  kind === "permission"
                    ? "Bash"
                    : kind === "question"
                      ? "AskUserQuestion"
                      : "ExitPlanMode",
                  kind === "permission"
                    ? { command: "git status" }
                    : kind === "question"
                      ? {
                          questions: [
                            {
                              question: "Choose?",
                              header: "Choice",
                              options: [{ label: "Yes", description: "Continue" }],
                            },
                          ],
                        }
                      : { plan: "A plan" },
                  {
                    signal: controller.signal,
                    toolUseID: kind === "permission" ? "tool-bash" : "tool-plan",
                    requestId: "request-tool",
                  },
                ),
              ).pipe(Effect.forkScoped);
        if (kind !== "exit-plan") yield* Queue.take(harness.runtimeRequestReceipts);
        else yield* Fiber.join(pending);
        yield* TestClock.adjust("11 minutes");
        assert.isEmpty(harness.terminalEvents());
        yield* stop;
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("a steer-correlated response keeps a long tool turn alive and Stop interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, input, allocator, attemptId, stop } = yield* setup();
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: allocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("steer-wait"),
          text: "Continue",
          attachments: [],
        },
      });
      const steerUuid = harness.offeredMessages.at(-1)?.uuid;
      assert.isDefined(steerUuid);
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "steer-tool",
            type: "message",
            role: "assistant",
            content: [
              { type: "tool_use", id: "long-tool", name: "Bash", input: { command: "sleep 1000" } },
            ],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000904",
          session_id: WAKE_NATIVE_SESSION,
          user_message_uuid: steerUuid,
        }),
      );
      yield* TestClock.adjust("11 minutes");
      assert.isEmpty(harness.terminalEvents());
      yield* stop;
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);

it.effect(
  "a root response held in early-echo mode disarms before display and still permits Stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { harness, allocator, input } = yield* setup();
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000910",
              text: "First answer",
            }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000911",
              result: "First answer",
            }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.awaitTerminal(1);
        const attemptId = RunAttemptId.make("early-echo-wait");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Second",
            attachments: [],
            providerTurnOrdinal: 2,
            nativeThreadHasTurns: true,
            runtimePolicy: input.runtimePolicy,
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(1),
            state: "started",
            uuid: "00000000-0000-4000-8000-000000000912",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* harness.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000913",
            text: "Held answer",
          }),
        );
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === "Held answer",
          ),
        );
        yield* TestClock.adjust("11 minutes");
        assert.equal(harness.terminalEvents().length, 1);
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: allocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          }),
        });
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "interrupted");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect.each(["compaction", "resume"] as const)(
  "keeps %s work alive and Stop interrupted",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { harness, stop } = yield* setup(kind === "resume");
        if (kind === "resume")
          assert.equal(harness.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...makeAssistantTextFrame({
              uuid: "00000000-0000-4000-8000-000000000920",
              text: "Working",
            }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        if (kind === "compaction")
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: "compacting",
              uuid: "00000000-0000-4000-8000-000000000921",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        yield* TestClock.adjust("11 minutes");
        assert.isEmpty(harness.terminalEvents());
        yield* stop;
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
);

it.effect("a held ExitPlanMode callback can wait without a watchdog failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { harness, allocator, input, controller } = yield* setup();
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000930",
            text: "First answer",
          }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000931",
            result: "First answer",
          }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* harness.awaitTerminal(1);
      const attemptId = RunAttemptId.make("held-exit-plan");
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId,
          text: "Plan",
          attachments: [],
          providerTurnOrdinal: 2,
          nativeThreadHasTurns: true,
          runtimePolicy: input.runtimePolicy,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(1),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000000932",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "held-plan-2",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "held-plan-tool",
                name: "ExitPlanMode",
                input: { plan: "A held plan" },
              },
            ],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000933",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      assert.isFalse(harness.events.some((event) => event.type === "plan.updated"));
      const options = harness.getOpenedOptions();
      const result = yield* Effect.promise(() =>
        options!.canUseTool!(
          "ExitPlanMode",
          { plan: "A held plan" },
          {
            signal: controller.signal,
            toolUseID: "held-plan-tool",
            requestId: "held-plan-request",
          },
        ),
      );
      assert.equal(result.behavior, "deny");
      assert.isFalse(harness.events.some((event) => event.type === "plan.updated"));
      yield* TestClock.adjust("11 minutes");
      assert.equal(harness.terminalEvents().length, 1);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: allocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
      });
      yield* harness.awaitTerminal(2);
      assert.equal(harness.terminalEvents()[1]?.status, "interrupted");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
