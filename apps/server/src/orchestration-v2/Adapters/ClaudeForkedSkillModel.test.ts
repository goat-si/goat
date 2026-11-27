import { RunAttemptId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import { claudeForkedSkillModels } from "./ClaudeForkedSkillModel.ts";
import { CLAUDE_TEST_MODEL_SELECTION, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  makeSubagentNotificationFrame,
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

const forkedSkillFrames = [
  // A `context: fork` skill has no Agent call and streams none of its own replies:
  // task_started carries no tool_use_id, and only its prompt echo names the fork.
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
];

const foregroundUnstreamedSubagentFrames = [
  claudeSdkFrame({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      model: "claude-opus-4-6",
      id: "msg_unstreamed_model_launch",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu-unstreamed-model",
          name: "Agent",
          input: { description: "One thing", prompt: "Check one thing." },
        },
      ],
    },
    uuid: "00000000-0000-4000-8000-000000000235",
    session_id: WAKE_NATIVE_SESSION,
  }),
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: "task-unstreamed-model",
    tool_use_id: "toolu-unstreamed-model",
    description: "One thing",
    task_type: "local_agent",
    uuid: "00000000-0000-4000-8000-000000000236",
    session_id: WAKE_NATIVE_SESSION,
  }),
  makeSubagentNotificationFrame({
    taskId: "task-unstreamed-model",
    toolUseId: "toolu-unstreamed-model",
    summary: "OK",
    uuid: "00000000-0000-4000-8000-000000000237",
  }),
];

const runTranscriptModelSubagent = (input: {
  readonly subagentModel: string | undefined;
  readonly text: string;
  readonly frames: ReadonlyArray<ReturnType<typeof claudeSdkFrame>>;
}) =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions(
      input.subagentModel === undefined ? {} : { subagentModel: input.subagentModel },
    );
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-transcript-model"),
        text: input.text,
        attachments: [],
        modelSelection: { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-opus-4-6" },
      }),
    );
    for (const frame of [
      ...input.frames,
      makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000234", result: "OK" }),
    ]) {
      yield* Queue.offer(harness.sdkMessages, frame);
    }
    yield* Queue.take(harness.terminalReceipts);
    return harness.events.filter((event) => event.type === "subagent.updated").at(-1)?.subagent;
  });

// regression: upstream #34848 & #39729 a forked skill or foreground subagent showed no model, or the parent's
it.effect.each([
  { launch: "forked skill", text: "/fork-probe go", frames: forkedSkillFrames },
  {
    launch: "foreground Agent call with no streamed reply",
    text: "Ask a subagent one thing.",
    frames: foregroundUnstreamedSubagentFrames,
  },
])(
  "records the model of a $launch from its transcript instead of the parent's",
  ({ text, frames }) =>
    Effect.gen(function* () {
      const subagent = yield* runTranscriptModelSubagent({
        subagentModel: "claude-haiku-4-5-20251001",
        text,
        frames,
      });
      assert.equal(subagent?.status, "completed");
      assert.equal(subagent?.model, "claude-haiku-4-5");
      assert.equal(subagent?.modelSelection?.model, "claude-haiku-4-5");
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect("leaves a forked skill's model unset when the lookup finds no model", () =>
  Effect.gen(function* () {
    const fork = yield* runTranscriptModelSubagent({
      subagentModel: undefined,
      text: "/fork-probe go",
      frames: forkedSkillFrames,
    });
    assert.equal(fork?.status, "completed");
    assert.isNull(fork?.model ?? null);
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);

it.effect("looks up nothing when the runner cannot read transcripts", () =>
  Effect.gen(function* () {
    const forked = new Map([
      ["task-forked", { task: { model: null, status: "completed" as const } }],
    ]);
    const updates = yield* claudeForkedSkillModels({
      taskIds: forked.keys(),
      registered: Effect.succeed(forked),
      lookup: undefined,
      canonical: (model) => model,
    });
    assert.deepEqual(updates, []);
    // The same task with a lookup is one the absent lookup would have answered.
    const looked = yield* claudeForkedSkillModels({
      taskIds: forked.keys(),
      registered: Effect.succeed(forked),
      lookup: () => Effect.succeed("claude-haiku-4-5"),
      canonical: (model) => model,
    });
    assert.deepEqual(looked, [
      { taskId: "task-forked", model: "claude-haiku-4-5", status: "completed" },
    ]);
  }),
);
