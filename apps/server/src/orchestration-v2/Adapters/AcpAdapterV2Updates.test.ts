import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  MAX_RESUMABLE_TEXT_SEGMENTS,
  makeAcpAdapterV2,
} from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

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

const textChunk = (
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
  messageId: string | undefined,
  text: string,
) => ({
  sessionUpdate,
  ...(messageId === undefined ? {} : { messageId }),
  content: { type: "text" as const, text },
});
const answer = (messageId: string | undefined, text: string) =>
  textChunk("agent_message_chunk", messageId, text);
const thought = (messageId: string | undefined, text: string) =>
  textChunk("agent_thought_chunk", messageId, text);
const agentMessage = (messageId: string, text: string) => ({
  sessionUpdate: "agent_message" as const,
  messageId,
  content: [{ type: "text" as const, text }],
});
type ScriptedTextStep = EffectAcpSchema.SessionUpdate | { readonly advance: Duration.Input };

const runScriptedTextTurn = Effect.fnUntraced(function* (steps: ReadonlyArray<ScriptedTextStep>) {
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let handler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  const instanceId = ProviderInstanceId.make("acp-named-text-resume");
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
          handleSessionUpdate: (next) =>
            Effect.sync(() => {
              handler = next;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
          prompt: () =>
            Effect.gen(function* () {
              const notify = handler;
              assert.isDefined(notify);
              for (const step of steps) {
                if ("advance" in step) yield* TestClock.adjust(step.advance);
                else yield* notify({ sessionId: "mock-session-1", update: step });
              }
              return { stopReason: "end_turn" as const };
            }),
        }),
      }),
    },
  });
  const threadId = ThreadId.make("thread-acp-named-text-resume");
  const modelSelection = { instanceId, model: "default" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-acp-named-text-resume"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
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
  return yield* runtime.events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );
});

const turnTextHistory = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const history = new Map<string, Array<OrchestrationV2TurnItem>>();
  for (const event of events) {
    if (event.type !== "turn_item.updated") continue;
    const item = event.turnItem;
    if (item.nativeItemRef?.nativeId?.includes(":turn:") !== true) continue;
    history.set(item.id, [...(history.get(item.id) ?? []), item]);
  }
  return history;
};

const finalTexts = (history: ReadonlyMap<string, ReadonlyArray<OrchestrationV2TurnItem>>) =>
  [...history.values()].flatMap((snapshots) => {
    const last = snapshots.at(-1);
    return last !== undefined && "text" in last ? [[last.type, last.text]] : [];
  });

describe("AcpAdapterV2 named text segments", () => {
  it.effect.each([
    {
      label: "a thought with its own id interrupts a named assistant message",
      steps: [
        answer("answer", "First. "),
        { advance: "1 second" },
        thought("thought", "Thinking"),
        answer("answer", "Second."),
      ],
      expected: [
        ["assistant_message", "First. Second."],
        ["reasoning", "Thinking"],
      ],
    },
    {
      label: "named assistant messages interleave",
      steps: [answer("a", "A1 "), answer("b", "B1"), answer("a", "A2")],
      expected: [
        ["assistant_message", "A1 A2"],
        ["assistant_message", "B1"],
      ],
    },
    {
      label: "a resumed message continues from authoritative text",
      steps: [
        answer("answer", "stale"),
        thought("thought", "Thinking"),
        agentMessage("answer", "fresh "),
        thought("thought", " more"),
        answer("answer", "tail"),
      ],
      expected: [
        ["assistant_message", "fresh tail"],
        ["reasoning", "Thinking more"],
      ],
    },
    {
      label: "opaque ids differ only in surrounding whitespace",
      steps: [answer("answer", "A"), answer(" answer ", "B")],
      expected: [
        ["assistant_message", "A"],
        ["assistant_message", "B"],
      ],
    },
    {
      label: "a chunk continues a full update with the same whitespace-padded id",
      steps: [agentMessage(" answer ", "A"), answer(" answer ", "B")],
      expected: [["assistant_message", "AB"]],
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly steps: ReadonlyArray<ScriptedTextStep>;
    readonly expected: ReadonlyArray<readonly [string, string]>;
  }>)("resumes ACP text segments when $label", ({ steps, expected }) =>
    Effect.gen(function* () {
      const history = turnTextHistory(yield* runScriptedTextTurn(steps));
      assert.deepEqual(finalTexts(history), expected);
      for (const snapshots of history.values()) {
        assert.equal(new Set(snapshots.map((item) => item.ordinal)).size, 1);
        assert.equal(new Set(snapshots.map((item) => DateTime.formatIso(item.startedAt!))).size, 1);
        assert.equal(snapshots.at(-1)?.status, "completed");
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("ignores a text flush scheduled before an ACP segment resumed", () =>
    Effect.gen(function* () {
      const events = yield* runScriptedTextTurn([
        answer("answer", "A"),
        answer("answer", "B"),
        thought("thought", "Thinking"),
        { advance: "30 millis" },
        answer("answer", "C"),
        answer("answer", "D"),
        { advance: "20 millis" },
        answer("answer", "E"),
        { advance: "30 millis" },
      ]);
      const snapshots = events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [[event.message.text, event.message.streaming]]
          : [],
      );
      assert.deepEqual(snapshots, [
        ["A", true],
        ["AB", false],
        ["ABC", true],
        ["ABCDE", true],
        ["ABCDE", false],
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps the closed messages a turn can resume to a bounded number", () =>
    Effect.gen(function* () {
      // One more named message than the adapter keeps, so the first one is no longer resumable.
      const others = Array.from({ length: MAX_RESUMABLE_TEXT_SEGMENTS }, (_, index) =>
        answer(`m${index + 1}`, `M${index + 1}`),
      );
      const history = turnTextHistory(
        yield* runScriptedTextTurn([
          answer("m0", "early "),
          ...others,
          answer("m1", " again"),
          answer("m0", "late"),
        ]),
      );
      const texts = finalTexts(history);
      assert.deepEqual(texts[0], ["assistant_message", "late"]);
      assert.deepEqual(texts[1], ["assistant_message", "M1 again"]);
      assert.lengthOf(texts, MAX_RESUMABLE_TEXT_SEGMENTS + 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
