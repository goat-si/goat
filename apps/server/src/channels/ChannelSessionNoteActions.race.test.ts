import { assert, it } from "@effect/vitest";
import {
  goatBotForgetNoteMessage,
  type ChannelGatewayError,
  type ChannelInputId,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ask, runsOf, sessionHarness } from "./ChannelBotSession.testkit.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import { makeChannelBotNoteWriter } from "./channelBotNoteTabEdits.ts";
import { NOTES_HEADER } from "./channelBotNoteLines.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelSessionNoteActions from "./channelSessionNoteActions.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { setupBot } from "./testkit/ChannelHarness.ts";

/** The edges of a session notes change that need the service itself: races and a failed queue. */

type Harness = ReturnType<typeof sessionHarness>;

const line = (text: string, id: string) => "- 2026-11-01: " + text + " (asked in " + id + ")";

const files = Effect.gen(function* () {
  return channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
});

/** A reception-started turn in the bot's session and the run that carries its request. */
const turn = (harness: Harness, text: string, key: string) =>
  Effect.gen(function* () {
    const task = yield* ask("look: " + text, key);
    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly thread_id: ThreadId;
      readonly message_id: string;
    }>`SELECT thread_id, message_id FROM channel_bot_session_runs
      WHERE task_id = ${task.taskId} ORDER BY created_at LIMIT 1`;
    const threadId = rows[0]!.thread_id;
    const run = runsOf(harness, threadId).find((r) => r.userMessageId === rows[0]!.message_id)!;
    return {
      task,
      inputId: task.originInputId as ChannelInputId,
      caller: { threadId, runId: run.id },
    };
  });

/** The service over a changed ledger or writer, sharing everything else with the harness. */
const actionsWith = (overrides: Layer.Layer<never>) =>
  Effect.gen(function* () {
    return Context.get(
      yield* Layer.build(
        Layer.fresh(ChannelSessionNoteActions.layer).pipe(Layer.provide(overrides)),
      ),
      ChannelSessionNoteActions.ChannelSessionNoteActions,
    );
  });

it.effect("a grant racing the task's completion is refused once the task finished", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const tidy = yield* turn(harness, "tidy my notes", "tidy");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const owner = (yield* ChannelRuntime.ChannelRuntime).ownerToken;
    let raced = false;
    const actions = yield* actionsWith(
      Layer.succeed(ChannelLedger.ChannelLedger, {
        ...ledger,
        // The task finishes between the grant's read and its write.
        applyTaskEvent: (input) =>
          raced
            ? ledger.applyTaskEvent(input)
            : Effect.gen(function* () {
                raced = true;
                yield* commitTransition(
                  ledger,
                  (yield* ledger.getTask(tidy.task.taskId))!,
                  {
                    type: "task.completed",
                    payload: { generation: tidy.task.generation, summary: "Done" },
                  },
                  { owner },
                );
                return yield* ledger.applyTaskEvent(input);
              }),
      }) as never,
    );
    const result = yield* actions.change({
      caller: tidy.caller,
      taskId: tidy.task.taskId,
      inputId: tidy.inputId,
      kind: "edit",
      quote: "tidy my notes",
    });
    assert.isTrue(raced);
    assert.strictEqual(result.reason, "task_finished");
    const task = yield* ledger.getTask(tidy.task.taskId);
    assert.isUndefined(task?.task.notesChangeRequested);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a remember issued during a forget's rewrite lands after it", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const fs = yield* FileSystem.FileSystem;
    const notes = yield* files;
    yield* fs.makeDirectory(notes.dir, { recursive: true });
    yield* fs.writeFileString(notes.notes, NOTES_HEADER + line("I deploy on Fridays.", "a") + "\n");
    const remember = yield* turn(harness, "remember that staging is staging-02", "remember");
    let duringRewrite: Effect.Effect<void> = Effect.void;
    const writer = yield* makeChannelBotNoteWriter(fs, notes, yield* ChannelLedger.ChannelLedger, {
      beforeCompare: Effect.suspend(() => duringRewrite),
    });
    const actions = yield* actionsWith(Layer.succeed(ChannelBotNoteWriter, writer) as never);
    let saving:
      | Fiber.Fiber<
          ChannelSessionNoteActions.NotesChangeResult,
          ChannelGatewayError | ChannelLedger.ChannelLedgerError
        >
      | undefined;
    duringRewrite = Effect.gen(function* () {
      duringRewrite = Effect.void;
      saving = yield* Effect.forkDetach(
        actions.change({
          caller: remember.caller,
          taskId: remember.task.taskId,
          inputId: remember.inputId,
          kind: "remember",
          note: "Staging is staging-02.",
          quote: "remember that staging is staging-02",
        }),
      );
    });
    const forgot = yield* writer.tabEdit(
      { intent: "message", text: goatBotForgetNoteMessage("I deploy on Fridays.") },
      "tab-forget",
      "2026-11-02T00:00:00.000Z",
      Effect.succeed(remember.task.requester),
    );
    assert.strictEqual(forgot?.text, CHANNEL_COPY.noteForgotten);
    assert.strictEqual((yield* Fiber.join(saving!)).outcome, "saved");
    const after = yield* fs.readFileString(notes.notes);
    assert.notInclude(after, "I deploy on Fridays.");
    assert.include(after, "Staging is staging-02. (asked in " + remember.inputId + ")");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("when the notice cannot be queued the tool does not say the person was told", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const asked = yield* turn(harness, "remember that I deploy on Fridays", "quote");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const actions = yield* actionsWith(
      Layer.succeed(ChannelLedger.ChannelLedger, {
        ...ledger,
        enqueueDeliveries: () =>
          Effect.fail(new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail: "x" })),
      }) as never,
    );
    const failed = yield* Effect.flip(
      actions.change({
        caller: asked.caller,
        taskId: asked.task.taskId,
        inputId: asked.inputId,
        kind: "remember",
        note: "I deploy on Fridays.",
        quote: "words the person never wrote",
      }),
    );
    assert.strictEqual(failed._tag, "ChannelLedgerError");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "a request bound to an earlier generation cannot change notes for the retried task",
  () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const tidy = yield* turn(harness, "tidy my notes", "tidy");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const owner = (yield* ChannelRuntime.ChannelRuntime).ownerToken;
      let reads = 0;
      const actions = yield* actionsWith(
        Layer.succeed(ChannelLedger.ChannelLedger, {
          ...ledger,
          // After the call is bound, the task finishes and is retried as its next generation.
          getTask: (taskId) =>
            Effect.gen(function* () {
              reads += 1;
              if (reads === 2) {
                yield* commitTransition(
                  ledger,
                  (yield* ledger.getTask(taskId))!,
                  {
                    type: "task.completed",
                    payload: { generation: tidy.task.generation, summary: "Done" },
                  },
                  { owner },
                );
                yield* commitTransition(
                  ledger,
                  (yield* ledger.getTask(taskId))!,
                  {
                    type: "task.retry.requested",
                    payload: { generation: tidy.task.generation + 1 },
                  },
                  { owner },
                );
              }
              return yield* ledger.getTask(taskId);
            }),
        }) as never,
      );
      const result = yield* actions.change({
        caller: tidy.caller,
        taskId: tidy.task.taskId,
        inputId: tidy.inputId,
        kind: "edit",
        quote: "tidy my notes",
      });
      assert.strictEqual(result.reason, "task_finished");
      const task = yield* ledger.getTask(tidy.task.taskId);
      assert.strictEqual(task?.task.generation, tidy.task.generation + 1);
      assert.isUndefined(task?.task.notesChangeRequested);
    }).pipe(Effect.provide(harness.layer));
  },
);
