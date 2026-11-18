import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

it.effect(
  "removes Cursor's task tool at a goatclaw limit of zero and reopens when it changes",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-subagents-" });
      const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-subagent-limit-thread");
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = {
        environmentId: EnvironmentId.make("fixture"),
        threadId,
        providerSessionId: "cursor-subagent-session",
        providerInstanceId: instanceId,
        endpoint: "http://fixture.invalid/mcp",
        authorizationHeader: "Bearer subagent-fixture",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const opens: CursorAgentSdk.CursorAgentSdkOpenInput[] = [];
      let sends = 0;
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (openInput) =>
            Effect.sync(() => {
              opens.push(openInput);
              return {
                agentId: "native-cursor-subagents",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: () =>
                  Effect.sync(() => {
                    const runId = `native-cursor-run-${++sends}`;
                    return {
                      agentId: "native-cursor-subagents",
                      runId,
                      wait: Effect.succeed({
                        id: runId,
                        requestId: `native-request-${sends}`,
                        status: "finished" as const,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              };
            }),
        }),
        Effect.provide(hostContext),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-subagent-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const turn = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn({
            threadId,
            providerThread,
            modelSelection,
            runtimePolicy,
            runId: RunId.make(`cursor-subagent-run-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: RunAttemptId.make(`cursor-subagent-attempt-${ordinal}`),
            rootNodeId: NodeId.make(`cursor-subagent-root-${ordinal}`),
            appThread: {
              id: threadId,
              projectId: ProjectId.make("cursor-subagent-project"),
              createdBy: "user",
              creationSource: "web",
              title: "Cursor subagents",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            message: {
              messageId: MessageId.make(`cursor-subagent-message-${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: "continue",
              attachments: [],
            },
          });
          yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.runHead,
          );
        });

      // Cursor has no concurrency cap, so only zero changes the tools; exclusions are fixed at open.
      for (const [index, nativeSubagentLimit] of [undefined, 0, 2, 3].entries()) {
        yield* sessions.set(
          nativeSubagentLimit === undefined ? config : { ...config, nativeSubagentLimit },
        );
        yield* turn(index + 1);
      }
      assert.deepEqual(
        opens.map((open) => open.options.disallowedTools),
        [undefined, ["task"], undefined],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);

type CursorTaskUpdate = Extract<
  InteractionUpdate,
  { readonly type: "tool-call-delta" }
>["taskUpdate"];

// Runs one Cursor turn whose only tool is a Task that streams `taskUpdates`, then completes with
// `conversationSteps` as the saved transcript.
const runCursorTaskTurn = Effect.fnUntraced(function* (
  taskUpdates: ReadonlyArray<CursorTaskUpdate>,
  conversationSteps: ReadonlyArray<unknown>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-task-" });
  const instanceId = ProviderInstanceId.make("cursor");
  const threadId = ThreadId.make("cursor-task-thread");
  const modelSelection = { instanceId, model: "composer-2.5" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: workspace,
  });
  const args = {
    description: "Explore",
    prompt: "Read package.json.",
    subagentType: { kind: "unspecified" as const },
    agentId: "cursor-task-agent",
    mode: "unspecified" as const,
  };
  const adapter = yield* makeCursorAdapterV2({
    instanceId,
    settings: yield* decodeCursorSettings({}),
    environment: { HOME: workspace },
  }).pipe(
    Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
      assertComplete: Effect.void,
      open: () =>
        Effect.succeed({
          agentId: "native-cursor-task",
          listMessages: Effect.succeed([]),
          close: Effect.void,
          send: (input) =>
            Effect.gen(function* () {
              const onDelta = input.onDelta;
              assert.isDefined(onDelta);
              yield* onDelta({
                type: "tool-call-started",
                modelCallId: "model-call",
                callId: "task-call",
                toolCall: { type: "task", args },
              });
              for (const taskUpdate of taskUpdates) {
                yield* onDelta({
                  type: "tool-call-delta",
                  modelCallId: "model-call",
                  callId: "task-call",
                  taskUpdate,
                });
              }
              yield* onDelta({
                type: "tool-call-completed",
                modelCallId: "model-call",
                callId: "task-call",
                toolCall: {
                  type: "task",
                  args,
                  result: {
                    status: "success",
                    value: {
                      conversationSteps: [...conversationSteps],
                      isBackground: false,
                      backgroundReason: "unspecified",
                    },
                  },
                },
              });
              return {
                agentId: "native-cursor-task",
                runId: "native-cursor-run",
                wait: Effect.succeed({
                  id: "native-cursor-run",
                  requestId: "native-request",
                  status: "finished" as const,
                  model: { id: "composer-2.5" },
                  durationMs: 1,
                }),
                cancel: Effect.void,
              };
            }).pipe(Effect.orDie),
        }),
    }),
    Effect.provide(TestProviderHost.layer({ cwd: workspace })),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("cursor-task-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  yield* runtime.startTurn({
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make("cursor-task-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("cursor-task-attempt"),
    rootNodeId: NodeId.make("cursor-task-root"),
    appThread: {
      id: threadId,
      projectId: ProjectId.make("cursor-task-project"),
      createdBy: "user",
      creationSource: "web",
      title: "Cursor subagent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    message: {
      messageId: MessageId.make("cursor-task-message"),
      createdBy: "user",
      creationSource: "web",
      text: "Spawn a subagent.",
      attachments: [],
    },
  });
  const events = yield* runtime.events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );
  assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "completed");
  const childThreadId = events.findLast((event) => event.type === "subagent.updated")?.subagent
    .childThreadId;
  assert.isDefined(childThreadId);
  return { events, childThreadId };
});

it.effect("streams Cursor Task updates into the child thread before the task completes", () =>
  Effect.gen(function* () {
    const read = { type: "read" as const, args: { path: "package.json" } };
    const { events, childThreadId } = yield* runCursorTaskTurn(
      [
        { type: "thinking-delta", text: "Reading package.json." },
        { type: "thinking-completed", thinkingDurationMs: 1 },
        { type: "text-delta", text: "Looking." },
        { type: "step-completed", stepId: 1, stepDurationMs: 1 },
        { type: "text-delta", text: "Reading it." },
        {
          type: "tool-call-started",
          modelCallId: "nested",
          callId: "nested-read",
          toolCall: read,
        },
        {
          type: "tool-call-completed",
          modelCallId: "nested",
          callId: "nested-read",
          toolCall: {
            ...read,
            result: {
              status: "success",
              value: { content: '{"name":"fixture"}', totalLines: 1, fileSize: 18 },
            },
          },
        },
      ],
      [
        { assistantMessage: { text: "Looking." } },
        { assistantMessage: { text: "Reading it." } },
        {
          toolCall: {
            toolCallId: "nested-read",
            readToolCall: { args: { path: "package.json" }, result: { success: {} } },
          },
        },
        { assistantMessage: { text: "The name is fixture." } },
      ],
    );
    const taskCompletedAt = events.findIndex(
      (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
    );
    const childItems = events.flatMap((event, index) =>
      event.type === "turn_item.updated" && event.turnItem.threadId === childThreadId
        ? [{ index, item: event.turnItem }]
        : [],
    );
    for (const type of ["reasoning", "dynamic_tool", "assistant_message"] as const) {
      assert.isTrue(
        childItems.some(({ index, item }) => item.type === type && index < taskCompletedAt),
        `${type} reached the child thread before the task completed`,
      );
    }
    assert.deepEqual(
      childItems.flatMap(({ item }): ReadonlyArray<unknown> =>
        item.status !== "completed"
          ? []
          : item.type === "reasoning" || item.type === "assistant_message"
            ? [{ type: item.type, text: item.text }]
            : item.type === "dynamic_tool"
              ? [{ type: item.type, toolName: item.toolName }]
              : [],
      ),
      [
        { type: "reasoning", text: "Reading package.json." },
        { type: "assistant_message", text: "Looking." },
        { type: "assistant_message", text: "Reading it." },
        { type: "dynamic_tool", toolName: "Read" },
        { type: "assistant_message", text: "The name is fixture." },
      ],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  ),
);

it.effect("fills a Cursor Task child from its saved steps where live updates fell short", () =>
  Effect.gen(function* () {
    const { events, childThreadId } = yield* runCursorTaskTurn(
      [
        { type: "step-started", stepId: 1 },
        {
          type: "tool-call-started",
          modelCallId: "nested",
          callId: "open",
          toolCall: { type: "read", args: { path: "open.json" } },
        },
        {
          type: "tool-call-started",
          modelCallId: "nested",
          callId: "lost",
          toolCall: { type: "read", args: { path: "lost.json" } },
        },
        {
          type: "tool-call-completed",
          modelCallId: "nested",
          callId: "live",
          toolCall: {
            type: "read",
            args: { path: "live.json" },
            result: {
              status: "success",
              value: { content: "{}", totalLines: 1, fileSize: 2 },
            },
          },
        },
        { type: "step-completed", stepId: 1, stepDurationMs: 1 },
        { type: "text-delta", text: "Saved ans" },
      ],
      [
        {
          toolCall: {
            toolCallId: "open",
            readToolCall: { args: { path: "open.json" }, result: { success: {} } },
          },
        },
        {
          toolCall: {
            toolCallId: "live",
            readToolCall: { args: { path: "live.json" }, result: { success: {} } },
          },
        },
        {
          toolCall: {
            toolCallId: "saved",
            readToolCall: { args: { path: "saved.json" }, result: { success: {} } },
          },
        },
        { assistantMessage: { text: "Saved answer." } },
      ],
    );
    const finalItems = new Map(
      events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.threadId === childThreadId
          ? [[event.turnItem.id, event.turnItem] as const]
          : [],
      ),
    );
    assert.deepEqual(
      Object.fromEntries(
        finalItems
          .values()
          .flatMap((item) =>
            item.type === "dynamic_tool"
              ? [[item.title, item.status]]
              : item.type === "assistant_message"
                ? [[item.text, item.status]]
                : [],
          ),
      ),
      {
        "Read open.json": "completed",
        "Read lost.json": "interrupted",
        "Read live.json": "completed",
        "Read saved.json": "completed",
        "Saved answer.": "completed",
      },
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  ),
);

it.effect(
  "bounds pending child text across a paused session and delivers the latest snapshot before completion",
  () =>
    Effect.gen(function* () {
      const chunk = "abcdefgh";
      const text = chunk.repeat(2_048);
      const { events, childThreadId } = yield* runCursorTaskTurn(
        [
          ...Array.from({ length: 2_048 }, () => ({ type: "text-delta" as const, text: chunk })),
          { type: "step-completed", stepId: 1, stepDurationMs: 1 },
          ...Array.from({ length: 32 }, (_, index): CursorTaskUpdate[] => [
            { type: "text-delta", text: `Step ${index}` },
            { type: "step-completed", stepId: index + 2, stepDurationMs: 1 },
          ]).flat(),
        ],
        [],
      );
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.threadId === childThreadId &&
        event.turnItem.type === "assistant_message"
          ? [event.turnItem]
          : [],
      );
      const first = items.find((item) => item.text === text);
      assert.isDefined(first);
      assert.deepEqual(
        items.filter((item) => item.id === first.id).map((item) => [item.status, item.text]),
        [
          ["running", text],
          ["completed", text],
        ],
      );
      assert.isAtMost(items.filter((item) => item.streaming).length, 16);
      assert.lengthOf(
        items.filter((item) => item.status === "completed"),
        33,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);

it.effect("extends a closed partial assistant step on the same child item and message", () =>
  Effect.gen(function* () {
    const { events, childThreadId } = yield* runCursorTaskTurn(
      [
        { type: "text-delta", text: "Saved ans" },
        { type: "step-completed", stepId: 1, stepDurationMs: 1 },
      ],
      [{ assistantMessage: { text: "Saved answer." } }],
    );
    const items = events.flatMap((event) =>
      event.type === "turn_item.updated" &&
      event.turnItem.threadId === childThreadId &&
      event.turnItem.type === "assistant_message"
        ? [event.turnItem]
        : [],
    );
    const live = items.find((item) => item.streaming);
    assert.isDefined(live);
    assert.deepEqual(
      [...new Map(items.map((item) => [item.id, item])).values()].map((item) => [
        item.id,
        item.text,
      ]),
      [[live.id, "Saved answer."]],
    );
    const messages = events.flatMap((event) =>
      event.type === "message.updated" &&
      event.message.threadId === childThreadId &&
      event.message.role === "assistant"
        ? [event.message]
        : [],
    );
    assert.deepEqual(
      [...new Map(messages.map((message) => [message.id, message])).values()].map((message) => [
        message.id,
        message.text,
      ]),
      [[live.messageId, "Saved answer."]],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  ),
);

it.effect(
  "applies a saved exit code to the existing child command when live completion carries no result",
  () =>
    Effect.gen(function* () {
      const toolCall = { type: "shell" as const, args: { command: "exit 7" } };
      const { events, childThreadId } = yield* runCursorTaskTurn(
        [
          { type: "tool-call-started", modelCallId: "nested", callId: "shell", toolCall },
          { type: "tool-call-completed", modelCallId: "nested", callId: "shell", toolCall },
        ],
        [
          {
            toolCall: {
              toolCallId: "shell",
              shellToolCall: {
                args: toolCall.args,
                result: { success: { exitCode: 7, stdout: "before exit", stderr: "failed" } },
              },
            },
          },
        ],
      );
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.threadId === childThreadId &&
        event.turnItem.type === "command_execution"
          ? [event.turnItem]
          : [],
      );
      const first = items[0];
      const final = items.at(-1);
      assert.isDefined(first);
      assert.isDefined(final);
      assert.deepEqual([...new Set(items.map((item) => item.id))], [first.id]);
      assert.equal(final.status, "failed");
      assert.equal(final.exitCode, 7);
      assert.equal(final.output, "before exit\nfailed");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);

it.effect.each([
  {
    name: "exact steps",
    live: ["Inspect logs.", "Check status."],
    saved: ["Inspect logs.", "Check status."],
    final: [
      ["Inspect logs.", 0],
      ["Check status.", 1],
    ],
  },
  {
    name: "partial steps",
    live: ["Inspect log", "Check stat"],
    saved: ["Inspect logs.", "Check status."],
    final: [
      ["Inspect logs.", 0],
      ["Check status.", 1],
    ],
  },
  {
    name: "overlapping prefixes",
    live: ["Build", "Build with cache"],
    saved: ["Build with cache: compile.", "Build with cache: validate."],
    final: [
      ["Build with cache: compile.", 0],
      ["Build with cache: validate.", 1],
    ],
  },
  {
    name: "saved-only steps before, between, and after live steps",
    live: ["Inspect logs.", "Check status."],
    saved: [
      "Check status. Open the dashboard first.",
      "Inspect logs.",
      "Read the alert.",
      "Check status.",
      "Close the dashboard.",
    ],
    final: [
      ["Check status. Open the dashboard first.", null],
      ["Inspect logs.", 0],
      ["Read the alert.", null],
      ["Check status.", 1],
      ["Close the dashboard.", null],
    ],
  },
  {
    name: "partial steps around an exact anchor",
    live: ["Build", "Check status.", "Finish"],
    saved: ["Build image.", "Check status.", "Finish review."],
    final: [
      ["Build image.", 0],
      ["Check status.", 1],
      ["Finish review.", 2],
    ],
  },
  {
    name: "live-only steps around an exact anchor",
    live: ["Starting.", "Check status.", "Done."],
    saved: ["Check status."],
    final: [
      ["Starting.", 0],
      ["Check status.", 1],
      ["Done.", 2],
    ],
  },
  {
    name: "duplicate saved steps",
    live: ["Check status.", "Inspect logs.", "Check status."],
    saved: ["Check status.", "Check status.", "Inspect logs.", "Check status."],
    final: [
      ["Check status.", 0],
      ["Check status.", null],
      ["Inspect logs.", 1],
      ["Check status.", 2],
    ],
  },
  {
    name: "two early partial matches before a later exact match",
    live: ["Build", "Check stat"],
    saved: ["Build the image.", "Check status.", "Build"],
    final: [
      ["Build the image.", 0],
      ["Check status.", 1],
      ["Build", null],
    ],
  },
  {
    name: "an exact match tied on match count with an earlier prefix",
    live: ["Build"],
    saved: ["Build the image.", "Build"],
    final: [
      ["Build the image.", null],
      ["Build", 0],
    ],
  },
  {
    name: "an earlier saved step tied with a later prefix",
    live: ["Build"],
    saved: ["Build the image.", "Build the package."],
    final: [
      ["Build the image.", 0],
      ["Build the package.", null],
    ],
  },
  {
    name: "a saved step with no live stream",
    live: [],
    saved: ["Inspect logs."],
    final: [["Inspect logs.", null]],
  },
])("preserves final child item order and identity for $name", ({ live, saved, final }) =>
  Effect.gen(function* () {
    const { events, childThreadId } = yield* runCursorTaskTurn(
      live.flatMap((text, index): CursorTaskUpdate[] => [
        { type: "text-delta", text },
        { type: "step-completed", stepId: index + 1, stepDurationMs: 1 },
      ]),
      saved.map((text) => ({ assistantMessage: { text } })),
    );
    const items = events.flatMap((event) =>
      event.type === "turn_item.updated" &&
      event.turnItem.threadId === childThreadId &&
      event.turnItem.type === "assistant_message"
        ? [event.turnItem]
        : [],
    );
    const liveIds = items
      .filter((item) => item.streaming)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => item.id);
    assert.lengthOf(liveIds, live.length);
    const settled = Array.from(new Map(items.map((item) => [item.id, item])).values()).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    assert.deepEqual(
      settled.map((item) => {
        const originalIndex = liveIds.indexOf(item.id);
        return [item.text, originalIndex < 0 ? null : originalIndex];
      }),
      final,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  ),
);
