import { assert, it } from "@effect/vitest";
import {
  goatBotForgetNoteMessage,
  type ChannelGatewayError,
  type ChannelInputId,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ask, runsOf, sessionHarness } from "./ChannelBotSession.testkit.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import { makeChannelBotNoteWriter } from "./channelBotNoteTabEdits.ts";
import { NOTES_HEADER } from "./channelBotNoteLines.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import * as ChannelSessionNoteActions from "./channelSessionNoteActions.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { owner as ownerFor, setupBot } from "./testkit/ChannelHarness.ts";

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

it.effect("a remember waiting for the writer is not saved once its task was retried", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const fs = yield* FileSystem.FileSystem;
    const notes = yield* files;
    yield* fs.makeDirectory(notes.dir, { recursive: true });
    yield* fs.writeFileString(notes.notes, NOTES_HEADER);
    const asked = yield* turn(harness, "remember that staging is staging-02", "remember");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const owner = (yield* ChannelRuntime.ChannelRuntime).ownerToken;
    const writer = yield* ChannelBotNoteWriter;
    // The checks before the writer pass; while the save waits for the lock the task finishes
    // and is retried as its next generation.
    const retried = Effect.gen(function* () {
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(asked.task.taskId))!,
        { type: "task.completed", payload: { generation: asked.task.generation, summary: "Done" } },
        { owner },
      );
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(asked.task.taskId))!,
        { type: "task.retry.requested", payload: { generation: asked.task.generation + 1 } },
        { owner },
      );
    });
    const actions = yield* actionsWith(
      Layer.succeed(ChannelBotNoteWriter, {
        ...writer,
        saveIf: ((guard, ...rest) =>
          Effect.andThen(
            Effect.orDie(retried),
            writer.saveIf(guard, ...rest),
          )) as typeof writer.saveIf,
      }) as never,
    );
    const result = yield* actions.change({
      caller: asked.caller,
      taskId: asked.task.taskId,
      inputId: asked.inputId,
      kind: "remember",
      note: "Staging is staging-02.",
      quote: "remember that staging is staging-02",
    });
    assert.strictEqual(result.reason, "task_finished");
    assert.strictEqual(yield* fs.readFileString(notes.notes), NOTES_HEADER);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a session turn is never retried into a new generation under a call it bound", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const asked = yield* turn(harness, "remember that staging is staging-02", "remember");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const owner = (yield* ChannelRuntime.ChannelRuntime).ownerToken;
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(asked.task.taskId))!,
      { type: "task.completed", payload: { generation: asked.task.generation, summary: "Done" } },
      { owner },
    );
    const threads = yield* ChannelBotThreads.ChannelBotThreads;
    const retried = yield* Effect.flip(
      threads.retry({ taskId: asked.task.taskId, clientRequestId: "again" }, ownerFor),
    );
    assert.strictEqual(retried.reason, "task_not_found");
    const task = yield* ledger.getTask(asked.task.taskId);
    assert.strictEqual(task?.task.generation, asked.task.generation);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a remember whose check passed is saved when the turn finishes before the write", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const fs = yield* FileSystem.FileSystem;
    const notes = yield* files;
    yield* fs.makeDirectory(notes.dir, { recursive: true });
    yield* fs.writeFileString(notes.notes, NOTES_HEADER);
    const asked = yield* turn(harness, "remember that staging is staging-02", "remember");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const owner = (yield* ChannelRuntime.ChannelRuntime).ownerToken;
    const writer = yield* ChannelBotNoteWriter;
    const finish = Effect.gen(function* () {
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(asked.task.taskId))!,
        { type: "task.completed", payload: { generation: asked.task.generation, summary: "Done" } },
        { owner },
      );
    });
    const actions = yield* actionsWith(
      Layer.succeed(ChannelBotNoteWriter, {
        ...writer,
        // The turn finishes after the check under the lock passed, before the line is written.
        saveIf: ((guard, ...rest) =>
          writer.saveIf(
            Effect.tap(guard, (refused) =>
              refused === undefined ? Effect.orDie(finish) : Effect.void,
            ),
            ...rest,
          )) as typeof writer.saveIf,
      }) as never,
    );
    const result = yield* actions.change({
      caller: asked.caller,
      taskId: asked.task.taskId,
      inputId: asked.inputId,
      kind: "remember",
      note: "Staging is staging-02.",
      quote: "remember that staging is staging-02",
    });
    assert.strictEqual(result.outcome, "saved");
    assert.strictEqual((yield* ledger.getTask(asked.task.taskId))?.task.status, "completed");
    assert.include(
      yield* fs.readFileString(notes.notes),
      "Staging is staging-02. (asked in " + asked.inputId + ")",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("two edits for different tasks never both hold a notes grant", () => {
  const harness = sessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const tidy = yield* turn(harness, "tidy my notes", "tidy");
    const forget = yield* turn(harness, "forget the deploy note", "forget");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const writer = yield* ChannelBotNoteWriter;
    // Completed once the second edit has made its own check, or is waiting to make it.
    const checked = yield* Deferred.make<void>();
    const second = yield* actionsWith(
      Layer.mergeAll(
        Layer.succeed(ChannelLedger.ChannelLedger, {
          ...ledger,
          listTasksByStatus: (statuses) =>
            Effect.tap(ledger.listTasksByStatus(statuses), () =>
              Deferred.succeed(checked, undefined),
            ),
        }),
        Layer.succeed(ChannelBotNoteWriter, {
          ...writer,
          exclusive: ((effect) =>
            Effect.andThen(
              Deferred.succeed(checked, undefined),
              writer.exclusive(effect),
            )) as typeof writer.exclusive,
        }),
      ) as never,
    );
    let other:
      | Fiber.Fiber<
          ChannelSessionNoteActions.NotesChangeResult,
          ChannelGatewayError | ChannelLedger.ChannelLedgerError
        >
      | undefined;
    const first = yield* actionsWith(
      Layer.succeed(ChannelLedger.ChannelLedger, {
        ...ledger,
        // While the first grant is being recorded, its run ends, the second turn's run starts and
        // the second edit runs; the first task stays open.
        applyTaskEvent: (input) =>
          Effect.gen(function* () {
            if (other === undefined) {
              harness.world.setStatus(tidy.caller.threadId, 1, "completed");
              other = yield* Effect.forkDetach(
                second.change({
                  caller: forget.caller,
                  taskId: forget.task.taskId,
                  inputId: forget.inputId,
                  kind: "edit",
                  quote: "forget the deploy note",
                }),
              );
              yield* Effect.race(Deferred.await(checked), Effect.asVoid(Fiber.await(other)));
            }
            return yield* ledger.applyTaskEvent(input);
          }),
      }) as never,
    );
    const granted = yield* first.change({
      caller: tidy.caller,
      taskId: tidy.task.taskId,
      inputId: tidy.inputId,
      kind: "edit",
      quote: "tidy my notes",
    });
    const refused = yield* Fiber.join(other!);
    const holders = (yield* ledger.listTasksByStatus([
      "received",
      "dispatching",
      "running",
      "waiting_input",
    ])).filter((open) => open.task.notesChangeRequested !== undefined);
    assert.deepStrictEqual(
      holders.map((open) => open.task.taskId),
      [tidy.task.taskId],
    );
    assert.strictEqual(granted.outcome, "granted");
    assert.strictEqual(refused.reason, "busy");
  }).pipe(Effect.provide(harness.layer));
});
