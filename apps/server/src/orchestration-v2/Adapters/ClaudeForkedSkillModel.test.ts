import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { CLAUDE_TEST_MODEL_SELECTION, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

// Only collectors opt into queue capture. A FIFO marker then acknowledges all
// provider events offered before it, after their collector callbacks finish.
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

const runForkedSkill = (subagentModel: string | undefined) =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions(
      subagentModel === undefined ? {} : { subagentModel },
    );
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-forked-skill-model"),
        text: "/fork-probe go",
        attachments: [],
        modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-opus-4-6" },
      }),
    );
    // A `context: fork` skill has no Agent call and streams none of its own replies:
    // task_started carries no tool_use_id, and only its prompt echo names the fork.
    for (const frame of [
      claudeSdkFrame({
        type: "system",
        subtype: "task_started",
        task_id: "task-forked-skill",
        description: "/fork-probe",
        prompt: "go",
        subagent_type: "general-purpose",
        task_type: "local_agent",
        skip_transcript: true,
        ambient: true,
        uuid: "00000000-0000-4000-8000-000000000231",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "system",
        subtype: "task_notification",
        task_id: "task-forked-skill",
        status: "completed",
        summary: "/fork-probe",
        output_file: "",
        uuid: "00000000-0000-4000-8000-000000000232",
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        parent_tool_use_id: "forked-command-fork-probe",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
        uuid: "00000000-0000-4000-8000-000000000233",
        session_id: WAKE_NATIVE_SESSION,
      }),
      makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000234", result: "OK" }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* Queue.take(harness.terminalReceipts);
    return harness.events.filter((event) => event.type === "subagent.updated").at(-1)?.subagent;
  });

// regression: upstream #34848 a forked skill showed no model, or the parent's
it.effect("records a forked skill's model from its transcript instead of the parent's", () =>
  Effect.gen(function* () {
    const fork = yield* runForkedSkill("claude-haiku-4-5-20251001");
    assert.equal(fork?.status, "completed");
    assert.equal(fork?.model, "claude-haiku-4-5");
    assert.equal(fork?.modelSelection?.model, "claude-haiku-4-5");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect("leaves a forked skill's model unset when the runner cannot read transcripts", () =>
  Effect.gen(function* () {
    const fork = yield* runForkedSkill(undefined);
    assert.equal(fork?.status, "completed");
    assert.isNull(fork?.model ?? null);
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
