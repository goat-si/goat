import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  subagentRouting,
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
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});

// Frame order captured from Claude Code 2.1.332: the fork's work arrives only after task_notification.
it.effect("shows a forked skill's commands and reply in its subagent thread", () =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-forked-skill-activity"),
        text: "/fork-probe go",
        attachments: [],
      }),
    );
    const forkParent = "forked-command-fork-probe";
    for (const frame of [
      claudeSdkFrame({
        type: "system",
        subtype: "task_started",
        task_id: "task-forked-activity",
        description: "/fork-probe",
        prompt: "go",
        subagent_type: "general-purpose",
        task_type: "local_agent",
        skip_transcript: true,
        ambient: true,
        uuid: "00000000-0000-4000-8000-000000000a01",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "system",
        subtype: "task_notification",
        task_id: "task-forked-activity",
        status: "completed",
        summary: "/fork-probe",
        output_file: "",
        uuid: "00000000-0000-4000-8000-000000000a02",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        parent_tool_use_id: forkParent,
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        uuid: "00000000-0000-4000-8000-000000000a03",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "assistant",
        parent_tool_use_id: forkParent,
        message: {
          model: "claude-haiku-5-5",
          id: "msg_fork_bash",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-fork-bash",
              name: "Bash",
              input: { command: "cat hello.txt", description: "Read hello.txt" },
            },
          ],
        },
        uuid: "00000000-0000-4000-8000-000000000a04",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        parent_tool_use_id: forkParent,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu-fork-bash", content: "greetings" }],
        },
        uuid: "00000000-0000-4000-8000-000000000a05",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "assistant",
        parent_tool_use_id: forkParent,
        message: {
          model: "claude-haiku-5-5",
          id: "msg_fork_reply",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "FORK-REPORT greetings" }],
        },
        uuid: "00000000-0000-4000-8000-000000000a06",
        session_id: WAKE_NATIVE_SESSION,
      }),
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000a07",
        result: "FORK-REPORT greetings",
      }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* Queue.take(harness.terminalReceipts);

    const routing = subagentRouting(harness.events, ["toolu-fork-bash"]);
    assert.isDefined(routing.childThreadId);
    assert.deepEqual(
      [...(routing.toolThreadIds.get("toolu-fork-bash") ?? [])],
      [routing.childThreadId],
      "the fork's Bash call never reached its subagent thread",
    );
    assert.include(routing.assistantTexts(routing.childThreadId), "FORK-REPORT greetings");
    const subagent = harness.events
      .filter((event) => event.type === "subagent.updated")
      .at(-1)?.subagent;
    assert.notEqual(subagent?.result, "/fork-probe", "the skill's name became its result");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect("shows a forked skill's work from its transcript while it runs, once", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-fork-" });
    const subagentsDir = path.join(
      configDir,
      "projects",
      "-workspace",
      WAKE_NATIVE_SESSION,
      "subagents",
    );
    yield* fileSystem.makeDirectory(subagentsDir, { recursive: true });
    const forkParent = "forked-command-fork-probe";
    const bashCall = {
      type: "assistant" as const,
      parent_tool_use_id: forkParent,
      message: {
        model: "claude-haiku-5-5",
        id: "msg_fork_live_bash",
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu-fork-live-bash",
            name: "Bash",
            input: { command: "cat hello.txt", description: "Read hello.txt" },
          },
        ],
      },
      uuid: "00000000-0000-4000-8000-000000000b04",
      session_id: WAKE_NATIVE_SESSION,
    };
    yield* fileSystem.writeFileString(
      path.join(subagentsDir, "agent-task-forked-live.jsonl"),
      `${JSON.stringify(bashCall)}\n`,
    );
    const harness = yield* makeWakeHarnessWithOptions({
      environment: { CLAUDE_CONFIG_DIR: configDir },
    });
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-forked-skill-live"),
        text: "/fork-probe go",
        attachments: [],
      }),
    );
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "system",
        subtype: "task_started",
        task_id: "task-forked-live",
        description: "/fork-probe",
        prompt: "go",
        subagent_type: "general-purpose",
        task_type: "local_agent",
        uuid: "00000000-0000-4000-8000-000000000b01",
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
    yield* TestClock.adjust("1 second");
    yield* harness.awaitUntil(
      () => subagentRouting(harness.events, ["toolu-fork-live-bash"]).toolThreadIds.size > 0,
      "forked skill live Bash call",
    );
    const running = harness.events
      .filter((event) => event.type === "subagent.updated")
      .at(-1)?.subagent;
    assert.equal(running?.status, "running", "the fork's command appeared only after it ended");

    // As captured from Claude Code 2.1.332: the fork's report is written to its transcript
    // just before task_notification and never sent on the stream.
    yield* fileSystem.writeFileString(
      path.join(subagentsDir, "agent-task-forked-live.jsonl"),
      `${JSON.stringify(bashCall)}\n${JSON.stringify({
        type: "assistant",
        parent_tool_use_id: forkParent,
        message: {
          model: "claude-haiku-5-5",
          id: "msg_fork_live_reply",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "FORK-REPORT greetings" }],
        },
        uuid: "00000000-0000-4000-8000-000000000b06",
        session_id: WAKE_NATIVE_SESSION,
      })}\n`,
    );
    for (const frame of [
      claudeSdkFrame({
        type: "system",
        subtype: "task_notification",
        task_id: "task-forked-live",
        status: "completed",
        summary: "/fork-probe",
        output_file: "",
        uuid: "00000000-0000-4000-8000-000000000b02",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "system",
        subtype: "init",
        uuid: "00000000-0000-4000-8000-000000000b09",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame(bashCall),
      claudeSdkFrame({
        type: "user",
        parent_tool_use_id: forkParent,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-fork-live-bash", content: "greetings" },
          ],
        },
        uuid: "00000000-0000-4000-8000-000000000b05",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          model: "claude-haiku-5-5",
          id: "msg_root_live_reply",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "FORK-REPORT greetings" }],
        },
        uuid: "00000000-0000-4000-8000-000000000b08",
        session_id: WAKE_NATIVE_SESSION,
      }),
      makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000b07",
        result: "FORK-REPORT greetings",
      }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* Queue.take(harness.terminalReceipts);

    const routing = subagentRouting(harness.events, ["toolu-fork-live-bash"]);
    const toolItemIds = new Set(
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId === "toolu-fork-live-bash"
          ? [event.turnItem.id]
          : [],
      ),
    );
    assert.equal(toolItemIds.size, 1, "the fork's command was shown twice");
    const completedCall = harness.events.findLast(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId === "toolu-fork-live-bash",
    );
    assert.equal(
      completedCall?.type === "turn_item.updated" ? completedCall.turnItem.status : undefined,
      "completed",
    );
    assert.deepEqual(routing.assistantTexts(routing.childThreadId), ["FORK-REPORT greetings"]);
    const subagent = harness.events
      .filter((event) => event.type === "subagent.updated")
      .at(-1)?.subagent;
    assert.equal(subagent?.result, "FORK-REPORT greetings");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
