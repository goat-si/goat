import { openSessionWithRunningCommand } from "./AntigravityWake.testkit.ts";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 work after the prompt ends", () => {
  // regression: #3823 a background task can report completion without a tool update.
  it.effect.each([
    { kind: "chunked success", full: false, status: "completed" as const },
    { kind: "full failure", full: true, status: "failed" as const },
  ])("releases an ACKed command from its only completion message ($kind)", ({ full, status }) =>
    Effect.gen(function* () {
      const taskId = "664880dc-701a-4ab3-bd22-c00e2e605178/task-60";
      const report =
        status === "failed"
          ? `Task id "${taskId}" failed with error: build failed.`
          : `Task id "${taskId}" finished with result:\nAll checks passed.`;
      const { command, usage, send, startTurn, throughPromptSettled, drain } =
        yield* openSessionWithRunningCommand({}, undefined, {
          initialToolCalls: [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call_fetch",
              kind: "execute",
              title: "node fetch_throughput.mjs",
              status: "in_progress",
              rawInput: { CommandLine: "node fetch_throughput.mjs", WaitMsBeforeAsync: 10000 },
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Tool is running as a background task with task id: ${taskId}`,
                  },
                },
              ],
            },
          ],
        });
      yield* startTurn(1, false);
      const initial = yield* throughPromptSettled;
      assert.isTrue(
        initial.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === command.toolCallId &&
            event.turnItem.status === "running",
        ),
      );
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Task id "other/task-9" finished with result: unrelated.\n`,
        },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const unrelated = Array.from(yield* drain);
      assert.isFalse(unrelated.some((event) => event.type === "turn.terminal"));
      if (full) {
        yield* send({
          sessionUpdate: "agent_message",
          messageId: "task-report",
          content: [{ type: "text", text: report }],
        });
      } else {
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: report.slice(0, 35) },
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: report.slice(35) },
        });
      }
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const events = Array.from(yield* drain);
      assert.isTrue(
        events.some(
          (event) => event.type === "message.updated" && event.message.text.includes(report),
        ),
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal"),
        "the completion releases the held turn",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === command.toolCallId &&
            event.turnItem.status === status,
        ),
      );
    }).pipe(Effect.provide(layerSession)),
  );
  // agy sets `IsDaemon` on a command it does not wait for. When it exits, the agent replies
  // with no prompt open.
  it.effect("continues in one run when a finished daemon wakes the agent", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, throughTerminal, requestPermission } =
        yield* openSessionWithRunningCommand({ IsDaemon: true, WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      const promptTerminal = (yield* throughTerminal).at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      // The agent can ask before the app has started the continuation run.
      const followUp = { toolCallId: "call_analyze", kind: "execute", title: "node analyze.mjs" };
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { ...followUp, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { requestId: "permission-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      assert.deepEqual(yield* Fiber.join(permission), {
        outcome: { outcome: "selected", optionId: "allow" },
      });

      // The model took 6.7 s to answer the finished command; the run must outlast that silence.
      yield* TestClock.adjust("10 seconds");
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "completed" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const finished = continued.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      assert.lengthOf(offers, 1, "one wake is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // A command whose terminal update never arrives would hold the run in Working forever with
  // an empty pending list and a finished reply above Stop.
  it.effect("settles a silent background command after the post-settle hold timeout", () =>
    Effect.gen(function* () {
      const { command, offers, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;

      // A running tool keeps the inactivity watchdog re-armed, so 20 silent minutes do not
      // settle this run on their own.
      yield* TestClock.adjust("20 minutes");
      yield* TestClock.adjust("11 minutes");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "completed",
        "the bounded hold finalizes the turn instead of leaving it running forever",
      );
      assert.equal(terminal?.type === "turn.terminal" && terminal.failure, null);
      assert.lengthOf(offers, 0, "a silent command produces no wake on its own");
      const commandItem = [...prompt, ...run].findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.isTrue(
        commandItem?.type === "turn_item.updated" && commandItem.turnItem.status === "completed",
        "the silent command is no longer left as live activity on a settled run",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps a silent scheduled wake in its run past the command hold bound", () =>
    Effect.gen(function* () {
      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, undefined, {
          initialToolCalls: [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call_schedule",
              kind: "other",
              title: "Run schedule",
              status: "in_progress",
              rawInput: { DurationSeconds: 3600, Prompt: "Continue the task" },
            },
          ],
        });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* TestClock.adjust("61 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_schedule",
        status: "completed",
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Picked the task back up." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(
        JSON.stringify(run),
        "Picked the task back up.",
        "the wake reply stays in the run",
      );
      assert.lengthOf(offers, 0);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps an unanswered question open past the command hold bound", () =>
    Effect.gen(function* () {
      const { command, usage, send, startTurn, until, throughPromptSettled, requestPermission } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const question = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "interaction_1", kind: "other", title: "Which port?" },
          options: [
            { optionId: "3000", name: "3000", kind: "allow_once" },
            { optionId: "8080", name: "8080", kind: "allow_once" },
          ],
        },
        { requestId: "question-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("31 minutes");
      yield* Fiber.interrupt(question);
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(run), "Here is the chart.", "the question kept the run open");
    }).pipe(Effect.provide(layerSession)),
  );

  // Command 2 finishes during reply 1; agy dequeues command 2 after reply 1's usage_update and
  // needs >3 s before streaming reply 2. Wait for reply 2 (bounded by the 2-minute quiet limit),
  // but still finalize at 3 s when both commands were batched into reply 1.
  it.effect.each([
    { case: "separate second wake", batched: false, stalls: false },
    { case: "batched into one wake reply", batched: true, stalls: false },
    { case: "stalled second wake hits quiet limit", batched: false, stalls: true },
  ])(
    "handles two parallel background commands finishing 500 ms apart ($case)",
    ({ batched, stalls }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-agy-race-" });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd1 = {
          toolCallId: "call_gates",
          kind: "execute",
          title: "bin/gates back",
          rawInput: { CommandLine: "bin/gates back", WaitMsBeforeAsync: 10000 },
        } as const;
        const cmd2 = {
          toolCallId: "call_tests",
          kind: "execute",
          title: "bin/session test",
          rawInput: { CommandLine: "bin/session test", WaitMsBeforeAsync: 10000 },
        } as const;
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd1, status: "in_progress" },
              { sessionUpdate: "tool_call", ...cmd2, status: "in_progress" },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;

        // Command 1 finishes and wakes the model.
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", status: "DONE", content: "priority=MESSAGE_PRIORITY_HIGH task-1" })}\n`,
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd1,
          status: "completed",
          rawOutput: { output: "ok larastan", exit_code: 0 },
        });

        // 500 ms later, command 2 also finishes while reply 1 is still in flight.
        yield* TestClock.adjust("500 millis");
        yield* writeFile(
          generated("messages"),
          "msg-2.json",
          JSON.stringify({
            id: "msg-2",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-2",
          }),
        );
        yield* send({
          sessionUpdate: "tool_call_update",
          ...cmd2,
          status: "completed",
          rawOutput: { output: "34 passed", exit_code: 0 },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");

        // Reply 1 streams and ends with usage_update #1.
        yield* TestClock.adjust("8 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: batched ? "gates and tests both passed." : "gates passed; waiting for tests.",
          },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("messages"),
          "read.json",
          JSON.stringify({ "msg-1": true, "msg-2": true }),
        );
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          (batched
            ? [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1 + task-2",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates and tests both passed.",
                }),
              ]
            : [
                JSON.stringify({
                  step_index: 1,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-1",
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  status: "DONE",
                  content: "gates passed; waiting for tests.",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "SYSTEM_MESSAGE",
                  status: "DONE",
                  content: "priority=MESSAGE_PRIORITY_HIGH task-2",
                }),
              ]
          ).join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");

        // Advance past the 3-second debounce.
        yield* TestClock.adjust("3 seconds");
        if (batched) {
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.include(JSON.stringify(run), "gates and tests both passed.");
          assert.lengthOf(offers, 0);
          return;
        }

        // Pending wake for command 2 must extend into the 2-minute quiet window before finalizing.
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        if (stalls) {
          yield* TestClock.adjust("2 minutes");
          const run = yield* until((event) => event.type === "turn.terminal");
          const terminal = run.at(-1);
          assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
          assert.lengthOf(offers, 0);
          return;
        }

        // Reply 2 arrives 6 seconds later (9 seconds after usage_update #1).
        yield* TestClock.adjust("6 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "All 34 tests passed." },
        });
        assert.equal((yield* Queue.takeAll(scheduledFinalizes)).at(-1), "2 minutes");
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          [
            JSON.stringify({
              step_index: 1,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-1",
            }),
            JSON.stringify({
              step_index: 2,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "gates passed; waiting for tests.",
            }),
            JSON.stringify({
              step_index: 3,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "priority=MESSAGE_PRIORITY_HIGH task-2",
            }),
            JSON.stringify({
              step_index: 4,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "All 34 tests passed.",
            }),
          ].join("\n") + "\n",
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(
          JSON.stringify(run),
          "All 34 tests passed.",
          "reply 2 must stay in the same run",
        );
        assert.lengthOf(offers, 0, "the open run needs no continuation");
      }).pipe(Effect.provide(layerSession)),
  );

  // A background command can finish while the initial prompt's final reply is still in flight,
  // so the tool is already `completed` when session/prompt returns end_turn while its wake sits
  // unread in the inbox.
  it.effect(
    "keeps the run open when a background command finishes before end_turn with an unread wake",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-agy-pre-settle-",
        });
        const generated = (kind: string) =>
          path.join(
            profile,
            "antigravity-acp",
            "brain",
            "mock-session-1",
            ".system_generated",
            kind,
          );
        const writeFile = (directory: string, name: string, body: string) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, name), body)));
        const cmd = {
          toolCallId: "call_mix",
          kind: "execute",
          title: "python3 voice.py mix",
          rawInput: { CommandLine: "python3 voice.py mix", WaitMsBeforeAsync: 10000 },
        } as const;
        yield* writeFile(
          generated("messages"),
          "msg-1.json",
          JSON.stringify({
            id: "msg-1",
            priority: "MESSAGE_PRIORITY_HIGH",
            sender: "mock-session-1/task-1",
          }),
        );
        const { usage, offers, scheduledFinalizes, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, undefined, {
            profileDirectory: profile,
            initialToolCalls: [
              { sessionUpdate: "tool_call", ...cmd, status: "in_progress" },
              {
                sessionUpdate: "tool_call_update",
                ...cmd,
                status: "completed",
                rawOutput: { output: "mixed.mp4", exit_code: 0 },
              },
            ],
          });
        yield* startTurn(1, false);
        yield* throughPromptSettled;
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");

        yield* TestClock.adjust("9 seconds");
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Mix finished." },
        });
        assert.equal(yield* Queue.take(scheduledFinalizes), "2 minutes");
        yield* writeFile(generated("messages"), "read.json", JSON.stringify({ "msg-1": true }));
        yield* writeFile(
          generated("logs"),
          "transcript.jsonl",
          `${JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "Mix finished." })}\n`,
        );
        yield* send(usage);
        assert.equal(yield* Queue.take(scheduledFinalizes), "3000 millis");
        yield* TestClock.adjust("3 seconds");

        const run = yield* until((event) => event.type === "turn.terminal");
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        assert.include(JSON.stringify(run), "Mix finished.");
        assert.lengthOf(offers, 0);
      }).pipe(Effect.provide(layerSession)),
  );

  // agy names its background commands `<session>/task-<n>`; the agent passes that to
  // goat_background_wait, which must not fail since the adapter already holds the run open.
  it.effect("accepts goat_background_wait for a command it already tracks", () =>
    Effect.gen(function* () {
      const { session, providerThread, startTurn, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const taskIds = ["mock-session-1/task-2"];
      assert.isDefined(session.awaitBackgroundTasks);
      const result = yield* session.awaitBackgroundTasks!({
        providerThread,
        taskIds,
        awaited: true,
      });
      assert.deepEqual(result.matched, taskIds);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("keeps the run open while a command the agent waits for still runs", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      for (const minute of [10, 20, 30]) {
        yield* TestClock.adjust("10 minutes");
        yield* send({
          sessionUpdate: "tool_call_update",
          ...command,
          status: "in_progress",
          rawOutput: { output: `fetched ${minute} pages` },
        });
      }
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Here is the chart.", "the reply is part of the run");
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // Files as agy 1.5.12 wrote them: the launch sits in the child's inbox, and the child's report
  // lands in the parent's inbox with no session update. Only the agent's own reply follows.
  it.effect.each([
    { reports: "after the prompt ends", duringPrompt: false },
    { reports: "while the prompt runs", duringPrompt: true },
  ])("keeps a detached subagent running until it reports $reports", ({ duringPrompt }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-antigravity-kids-",
      });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const report = write(records("mock-session-1", "messages"), "report.json", {
        sender: "child-1",
      });
      if (duringPrompt) yield* report;

      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      const statuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent.status] : [],
        );
      const prompt = yield* throughPromptSettled;
      assert.equal(statuses(prompt).at(-1), duringPrompt ? "idle" : "running");
      if (!duringPrompt) {
        yield* TestClock.adjust("10 minutes");
        yield* report;
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher found it." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
      }
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.equal(statuses([...prompt, ...run]).at(-1), "idle");
      assert.equal(
        JSON.stringify(run).includes("The researcher found it."),
        !duringPrompt,
        "the reply about the report is part of the run",
      );
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("ends a continuation run whose replayed reply launched a subagent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // No records: nothing proves a child is at work, so none may hold a run open.
      const profile = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-antigravity-kids-",
      });
      const { usage, offers, send, startTurn, throughTerminal } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_follow_up",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { TypeName: "research", Role: "Checker", Prompt: "Check it" },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Started a checker." },
      });
      yield* send(usage);
      assert.lengthOf(offers, 1, "the agent's own reply must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* TestClock.adjust("3 seconds");
      const terminal = (yield* throughTerminal).at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([
    // session/cancel ends the agent's commands, so only Stop may send it.
    { ending: "Stop", cancels: 1, status: "interrupted" },
    { ending: "a new message", cancels: 0, status: "interrupted" },
    { ending: "the agent exiting", cancels: 0, status: "failed" },
  ] as const)(
    "ends a run held open by a running command on $ending",
    ({ ending, cancels, status }) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
        yield* opened.startTurn(1, false);
        const started = yield* opened.throughPromptSettled;
        const turn = started.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");
        if (ending === "the agent exiting") {
          yield* opened.runtimeDies;
        } else {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            ...(ending === "Stop" ? { requestRuntimeRestart: true } : {}),
          });
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, status);
        assert.equal(opened.cancels(), cancels);
      }).pipe(Effect.provide(layerSession)),
  );
});
