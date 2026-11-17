import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { CLAUDE_TEST_RUNTIME_POLICY, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
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
  NodeCrypto.layer,
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
    // An exited background command stays listed until its wake run starts.
    assert.deepEqual(
      last?.providerThread.pendingBackgroundTasks?.map((task) => task.taskId),
      ["task-2", "task-1"],
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

const startBackgroundTurn = (attempt: string, interactionMode: "default" | "plan" = "default") =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(attempt),
        text: "Build it",
        attachments: [],
        runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, interactionMode },
      }),
    );
    const system = (value: object) =>
      harness.offerAndWait(
        frame({ type: "system", ...value, session_id: "native-thread-claude-wake" }),
      );
    const started = (taskId: string, toolUseId: string | undefined, backgrounded: boolean) =>
      system({
        subtype: "task_started",
        task_id: taskId,
        ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
        description: taskId,
        is_backgrounded: backgrounded,
        task_type: "local_bash",
        uuid: "started-" + taskId,
      });
    const roster = (taskIds: ReadonlyArray<string>, uuid: string) =>
      system({
        subtype: "background_tasks_changed",
        tasks: taskIds.map((taskId) => ({
          task_id: taskId,
          task_type: "local_bash",
          description: taskId,
        })),
        uuid,
      });
    const latest = (taskId: string) =>
      harness.events
        .flatMap((event) =>
          event.type === "provider_thread.updated"
            ? (event.providerThread.pendingBackgroundTasks ?? [])
            : [],
        )
        .findLast((task) => task.taskId === taskId);
    return { harness, system, started, roster, latest };
  });

// regression: upstream #26668 a command moved to the background lost its tool call
it.effect(
  "keeps the tool call, command and call time of a command that moves to the background",
  () =>
    Effect.gen(function* () {
      const { harness, started, roster, latest } = yield* startBackgroundTurn("moved-command");
      const calledAt = DateTime.formatIso(yield* DateTime.now);
      yield* harness.offerAndWait(
        frame({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "msg-moved",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_moved",
                name: "Bash",
                input: { command: "npm run build" },
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: "moved-launch",
          session_id: "native-thread-claude-wake",
        }),
      );
      yield* TestClock.adjust("5 seconds");
      yield* started("task-moved", "toolu_moved", false);
      yield* TestClock.adjust("5 seconds");
      yield* roster(["task-moved"], "moved-roster");
      assert.deepEqual(latest("task-moved"), {
        taskId: "task-moved",
        kind: "command",
        description: "task-moved",
        nativeItemId: "toolu_moved",
        command: "npm run build",
        startedAt: calledAt,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("names no tool call it was not given, has forgotten, or evicted for a newer one", () =>
  Effect.gen(function* () {
    const { started, roster, latest, system } = yield* startBackgroundTurn("launch-memory");
    yield* started("evicted", "toolu_evicted", false);
    yield* started("no-call", undefined, true);
    yield* started("blank-call", "  ", true);
    yield* started("live", "toolu_live", true);
    yield* started("ended", "toolu_ended", false);
    yield* system({
      subtype: "task_notification",
      task_id: "ended",
      status: "completed",
      summary: "ended",
      output_file: "",
      uuid: "ended-notification",
    });
    for (let index = 0; index < 64; index++)
      yield* started("fg-" + index, "toolu_fg_" + index, false);
    yield* roster(["no-call", "blank-call", "live", "ended", "evicted", "fg-63"], "after-many");
    assert.isUndefined(latest("no-call")?.nativeItemId);
    assert.isUndefined(latest("blank-call")?.nativeItemId);
    assert.isUndefined(latest("ended")?.nativeItemId);
    assert.isUndefined(latest("evicted")?.nativeItemId);
    assert.equal(latest("fg-63")?.nativeItemId, "toolu_fg_63");
    // The launch memory evicted it, but the live roster entry keeps it.
    assert.equal(latest("live")?.nativeItemId, "toolu_live");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// The wait writes only the awaited flag, and only on its own thread's roster; the server then
// refuses a wait that matched nothing (ThreadManagementService awaitBackgroundTasks).
it.effect.each(["default", "plan"] as const)(
  "a %s-mode wait sets nothing on a task its thread's roster does not hold",
  (mode) =>
    Effect.gen(function* () {
      const { harness, started, latest } = yield* startBackgroundTurn("wait-" + mode, mode);
      const awaitBackgroundTasks = harness.runtime.awaitBackgroundTasks;
      if (awaitBackgroundTasks === undefined) throw new Error("Claude must expose the wait.");
      yield* started("task-held", "toolu_held", true);
      const otherThread = {
        ...harness.providerThread,
        nativeThreadRef: { driver: "claudeAgent", nativeId: "other-native", strength: "strong" },
      } as const;
      const fromOther = yield* awaitBackgroundTasks({
        providerThread: otherThread,
        taskIds: ["task-held"],
        awaited: true,
      });
      const unknown = yield* awaitBackgroundTasks({
        providerThread: harness.providerThread,
        taskIds: ["not-on-roster"],
        awaited: true,
      });
      assert.deepEqual([fromOther.matched, unknown.matched], [[], []]);
      yield* harness.awaitEventsRecorded;
      assert.isUndefined(latest("task-held")?.awaited);
      // The thread that holds it can mark it, so the check above can see a mark.
      yield* awaitBackgroundTasks({
        providerThread: harness.providerThread,
        taskIds: ["task-held"],
        awaited: true,
      });
      yield* harness.awaitEventsRecorded;
      assert.isTrue(latest("task-held")?.awaited);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
