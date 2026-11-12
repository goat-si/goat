import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { subagentResultForRun } from "@goat/provider-core/server/subagentProjection";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
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

const frame = (value: object) => value as SDKMessage;
const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

it.effect("preserves a background command and its start time across roster snapshots", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("background-details"),
        text: "Run audit",
        attachments: [],
      }),
    );
    yield* harness.offerAndWait(
      frame({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: "msg",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "python audit.py", run_in_background: true },
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "launch",
        session_id: "native-thread-claude-wake",
      }),
    );
    yield* harness.offerAndWait(
      frame({
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        tool_use_id: "tool-1",
        description: "Audit",
        is_backgrounded: true,
        task_type: "local_bash",
        uuid: "started",
        session_id: "native-thread-claude-wake",
      }),
    );
    const roster = () =>
      harness.events
        .flatMap((event) =>
          event.type === "provider_thread.updated"
            ? (event.providerThread.pendingBackgroundTasks ?? [])
            : [],
        )
        .filter((task) => task.taskId === "task-1");
    const first = roster().at(-1);
    assert.equal(Reflect.get(first ?? {}, "command"), "python audit.py");
    assert.isString(Reflect.get(first ?? {}, "startedAt"));
    yield* harness.offerAndWait(
      frame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "task-1", task_type: "local_bash", description: "Audit" }],
        uuid: "snapshot",
        session_id: "native-thread-claude-wake",
      }),
    );
    assert.equal(Reflect.get(roster().at(-1) ?? {}, "command"), "python audit.py");
    assert.equal(
      Reflect.get(roster().at(-1) ?? {}, "startedAt"),
      Reflect.get(first ?? {}, "startedAt"),
    );
    yield* harness.offerAndWait(
      frame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "task-2", task_type: "local_bash", description: "Other" }],
        uuid: "replace",
        session_id: "native-thread-claude-wake",
      }),
    );
    const last = harness.events.filter((event) => event.type === "provider_thread.updated").at(-1);
    assert.deepEqual(
      last?.providerThread.pendingBackgroundTasks?.map((task) => task.taskId),
      ["task-2"],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("records the model reported by Claude init on the completed delegated turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("actual-model"),
        text: "Do the task",
        attachments: [],
      }),
    );
    yield* Queue.offer(
      harness.sdkMessages,
      frame({
        type: "system",
        subtype: "init",
        model: "claude-opus-4-5-20251101",
        uuid: "init",
        session_id: "native-thread-claude-wake",
      }),
    );
    yield* Queue.offer(
      harness.sdkMessages,
      frame({
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 10,
        is_error: false,
        num_turns: 1,
        result: "Done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "result",
        session_id: "native-thread-claude-wake",
        terminal_reason: "completed",
      }),
    );
    yield* Queue.take(harness.terminalReceipts);
    yield* harness.awaitEventsRecorded;
    const turn = harness.events.filter((event) => event.type === "provider_turn.updated").at(-1);
    assert.equal(Reflect.get(turn?.providerTurn ?? {}, "model"), "claude-opus-4-5");
    if (turn === undefined) throw new Error("No provider turn");
    const result = subagentResultForRun(
      { messages: [], turnItems: [], providerTurns: [turn.providerTurn] },
      {
        id: "run",
        status: "completed",
        activeAttemptId: RunAttemptId.make("actual-model"),
        modelSelection: { model: "claude-sonnet-4-6" },
      } as never,
    );
    assert.include(result.text, "provider reported running claude-opus-4-5");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
