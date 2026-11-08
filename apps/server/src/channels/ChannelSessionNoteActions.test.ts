import { assert, describe, it } from "@effect/vitest";
import {
  goatBotForgetNoteMessage,
  ProviderInstanceId,
  type ChannelInputId,
  type ChannelTaskId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ChannelHandlers from "../mcp/toolkits/channel/handlers.ts";
import { ChannelToolkit } from "../mcp/toolkits/channel/tools.ts";
import { ask, runsOf, sessionHarness } from "./ChannelBotSession.testkit.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";
import * as ChannelSessionTaskActions from "./channelSessionTaskActions.ts";
import { NOTES_HEADER, parseChannelBotNoteLines } from "./channelBotNoteLines.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { deliveryIdFor, taskIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  botMessages,
  environmentId,
  goatInput,
  linkSlackUser,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/**
 * Notes changes asked for in chat under the default session routing: the session's model calls
 * goat_channel_notes_change, and the server checks which run calls, which person's message it acts for,
 * that person's access now, and that the quote is in that message.
 */

type Harness = ReturnType<typeof sessionHarness>;
type Caller = { readonly threadId: ThreadId; readonly runId: RunId };
type NotesResult = {
  readonly outcome?: "saved" | "granted" | "refused";
  readonly reason?: string;
  readonly told?: boolean;
  readonly code?: string;
};

const scopeFor = (caller: Caller) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "notes-change",
    grantedScopes: ["orchestration:operate" as const],
    thread: {
      threadId: caller.threadId,
      runId: caller.runId,
      providerSessionId: "provider:session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  });

/** The session thread as GOAT's MCP caller checks see it while the calling run works. */
const liveShell = (caller: Caller) => ({
  deletedAt: null,
  archivedAt: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: caller.runId,
  runtimeMode: "full-access",
  interactionMode: "default",
});

/** What the tool answers the session's model, or the failure it reports. */
const callNotes = (harness: Harness, caller: Caller, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    harness.world.shells.set(caller.threadId, liveShell(caller) as never);
    const toolkit = yield* ChannelToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    );
    const out = yield* toolkit
      .handle("goat_channel_notes_change" as never, args as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return out.at(-1)!.result as unknown as NotesResult;
  }).pipe(Effect.provide(scopeFor(caller)));

const notesFile = Effect.gen(function* () {
  return channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
});
const writeNotes = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* notesFile;
    yield* fs.makeDirectory(files.dir, { recursive: true });
    yield* fs.writeFileString(files.notes, text);
    return files;
  });
const readNotes = Effect.gen(function* () {
  return yield* (yield* FileSystem.FileSystem).readFileString((yield* notesFile).notes);
});
const line = (text: string, id: string) => "- 2026-11-01: " + text + " (asked in " + id + ")";

/** Text GOAT sent the session for one message id, as a launch or as a send. */
const sentText = (harness: Harness, messageId: string) =>
  harness.world.launches.find((launch) => launch.initialMessage?.messageId === messageId)
    ?.initialMessage?.text ??
  harness.world.sends.find((send) => send.messageId === messageId)?.text ??
  "";

/** The session run that carries a task's own request, and what GOAT sent it. */
const boundTurn = (harness: Harness, inputId: ChannelInputId) =>
  Effect.gen(function* () {
    const task = (yield* (yield* ChannelLedger.ChannelLedger).getTask(taskIdFor(inputId, 0)))!.task;
    const rows = yield* (yield* SqlClient.SqlClient)<{
      readonly thread_id: ThreadId;
      readonly message_id: string;
    }>`SELECT thread_id, message_id FROM channel_bot_session_runs
      WHERE task_id = ${task.taskId} ORDER BY created_at LIMIT 1`;
    const threadId = rows[0]!.thread_id;
    const run = runsOf(harness, threadId).find((r) => r.userMessageId === rows[0]!.message_id)!;
    return {
      task,
      inputId,
      caller: { threadId, runId: run.id } satisfies Caller,
      sent: sentText(harness, rows[0]!.message_id),
    };
  });

/** A main-conversation message the default routing turns into a session turn by itself. */
const sessionTurn = (harness: Harness, text: string, key: string) =>
  Effect.gen(function* () {
    const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
      goatInput(text, key),
      rpcContext,
    );
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    return yield* boundTurn(harness, input.inputId);
  });

/**
 * A turn reception queues into the same session. Used where a test needs several turns or a
 * follow-up, which the runtime would otherwise hold behind the first turn's open receipt.
 */
const lookTurn = (harness: Harness, text: string, key: string) =>
  Effect.gen(function* () {
    const task = yield* ask("look: " + text, key);
    return yield* boundTurn(harness, task.originInputId);
  });

/** A person's follow-up in a task's thread, forwarded to the session; returns what GOAT sent. */
const followUp = (harness: Harness, taskId: ChannelTaskId, text: string, key: string) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const before = harness.world.sends.length;
    const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
      { ...goatInput(text, key), taskId },
      rpcContext,
    );
    yield* runtime.drain;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    for (const pending of yield* ledger.listPendingForwards(10))
      yield* dispatcher.forward(pending, runtime.ownerToken);
    const send = harness.world.sends.slice(before).find((s) => s.text.includes(text))!;
    return { inputId: input.inputId, sent: send.text, messageId: send.messageId };
  });

const inputIdIn = (sent: string, pattern: RegExp) => sent.match(pattern)?.[1] as ChannelInputId;

const notices = Effect.gen(function* () {
  const rows = yield* (yield* SqlClient.SqlClient)<{ readonly message_json: string }>`
    SELECT message_json FROM channel_outbox WHERE cause_key LIKE 'note-request:%' ORDER BY rowid`;
  return rows.map((row) => (JSON.parse(row.message_json) as { readonly text: string }).text);
});

const fridays = "I deploy on Fridays.";

const remember = (
  turn: { readonly task: { readonly taskId: ChannelTaskId }; readonly inputId: ChannelInputId },
  note: string,
  quote: string,
  extra: Record<string, unknown> = {},
) => ({ taskId: turn.task.taskId, inputId: turn.inputId, kind: "remember", note, quote, ...extra });

const edit = (
  turn: { readonly task: { readonly taskId: ChannelTaskId }; readonly inputId: ChannelInputId },
  quote: string,
) => ({ taskId: turn.task.taskId, inputId: turn.inputId, kind: "edit", quote });

describe("notes changes from a GOAT Bot session turn", () => {
  it.effect(
    "remember from a session turn on the default routing saves one line with its source",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* writeNotes(NOTES_HEADER);
        const turn = yield* sessionTurn(harness, "remember that I deploy on Fridays", "remember");
        const inputId = inputIdIn(turn.sent, /Request input: (\S+)/u);
        const result = yield* callNotes(harness, turn.caller, {
          ...remember(turn, fridays, "remember that I deploy on Fridays"),
          inputId,
        });
        assert.strictEqual(result.outcome, "saved");
        assert.include(yield* readNotes, fridays + " (asked in " + turn.inputId + ")");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("an actually correction is saved with a replaces marker", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const turn = yield* sessionTurn(harness, "actually I deploy on Mondays", "correct");
      const result = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, "I deploy on Mondays.", "actually I deploy on Mondays", {
          replaces: fridays,
        }),
      );
      assert.strictEqual(result.outcome, "saved");
      const notes = parseChannelBotNoteLines(yield* readNotes);
      assert.isDefined(notes.find((note) => note.text === fridays)?.replacedBy);
      assert.strictEqual(notes.at(-1)?.text, "I deploy on Mondays.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the input id is read from the text GOAT sent the session", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const turn = yield* lookTurn(harness, "look into the deploy", "look");
      assert.strictEqual(inputIdIn(turn.sent, /Request input: (\S+)/u), turn.inputId);
      const more = yield* followUp(harness, turn.task.taskId, "also check the logs", "more");
      assert.strictEqual(inputIdIn(more.sent, /\(input (\S+?)\)/u), more.inputId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a run of another task in the same session cannot change notes for this task", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const first = yield* lookTurn(harness, "look into the deploy", "first");
      const second = yield* lookTurn(harness, "remember that I deploy on Fridays", "second");
      const result = yield* callNotes(
        harness,
        first.caller,
        remember(second, fridays, "remember that I deploy on Fridays"),
      );
      assert.isDefined(result.code);
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a call that lands before the run is recorded is accepted", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const turn = yield* sessionTurn(harness, "remember that I deploy on Fridays", "early");
      yield* (yield* SqlClient.SqlClient)`
        UPDATE channel_bot_session_runs SET run_id = NULL WHERE task_id = ${turn.task.taskId}`;
      const result = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, fridays, "remember that I deploy on Fridays"),
      );
      assert.strictEqual(result.outcome, "saved");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a queued run or a finished run cannot change notes", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const first = yield* lookTurn(harness, "remember that I deploy on Fridays", "first");
      const second = yield* lookTurn(harness, "remember that staging is staging-02", "second");
      const queued = yield* callNotes(
        harness,
        second.caller,
        remember(second, "Staging is staging-02.", "remember that staging is staging-02"),
      );
      assert.isDefined(queued.code);
      harness.world.setStatus(first.caller.threadId, 1, "completed");
      const finished = yield* callNotes(
        harness,
        first.caller,
        remember(first, fridays, "remember that I deploy on Fridays"),
      );
      assert.isDefined(finished.code);
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a remember reception already saved for the input adds no second line", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const files = yield* writeNotes(NOTES_HEADER);
      const turn = yield* sessionTurn(harness, "remember that I deploy on Fridays", "dup");
      yield* appendChannelBotNote(
        yield* FileSystem.FileSystem,
        files,
        fridays,
        "2026-11-02T10:00:00Z",
        turn.inputId,
      );
      const before = yield* readNotes;
      const result = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, "I deploy every Friday.", "remember that I deploy on Fridays"),
      );
      assert.strictEqual(result.outcome, "saved");
      assert.strictEqual(yield* readNotes, before);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a follow-up's first remember is saved under the follow-up's input", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const turn = yield* lookTurn(harness, "look into the deploy", "look");
      const more = yield* followUp(
        harness,
        turn.task.taskId,
        "also remember that staging is staging-02",
        "more",
      );
      const result = yield* callNotes(harness, turn.caller, {
        ...remember(turn, "Staging is staging-02.", "remember that staging is staging-02"),
        inputId: inputIdIn(more.sent, /\(input (\S+?)\)/u),
      });
      assert.strictEqual(result.outcome, "saved");
      assert.include(yield* readNotes, "(asked in " + more.inputId + ")");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a follow-up from a sender who may not change notes is refused", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const turn = yield* lookTurn(harness, "look into the deploy", "look");
      const more = yield* followUp(
        harness,
        turn.task.taskId,
        "also remember that staging is staging-02",
        "more",
      );
      // The follow-up came from a Slack person with no link on its connection now.
      const sender = {
        ...turn.task.requester,
        principalId: "principal-gone",
        originKind: "slack",
        externalActorId: "U-GONE",
      };
      yield* (yield* SqlClient.SqlClient)`
        UPDATE channel_inbox SET requester_json = ${JSON.stringify(sender)}
        WHERE input_id = ${more.inputId}`;
      const result = yield* callNotes(harness, turn.caller, {
        ...remember(turn, "Staging is staging-02.", "remember that staging is staging-02"),
        inputId: more.inputId,
      });
      assert.strictEqual(result.reason, "not_allowed");
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
      assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteEditNotAllowed]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a follow-up a session tool wrote cannot carry a notes change", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const target = yield* lookTurn(harness, "remember that I deploy on Fridays", "target");
      const actions = yield* ChannelSessionTaskActions.ChannelSessionTaskActions;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* actions.followUp({
        caller: target.caller,
        taskId: target.task.taskId,
        text: "remember that I deploy on Fridays",
        clientRequestId: "agent-words",
      });
      // The task's first run has ended, so the agent's follow-up starts a run of its own.
      harness.world.setStatus(target.caller.threadId, 1, "completed");
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      const carrier = runsOf(harness, target.caller.threadId).at(-1)!;
      assert.notStrictEqual(carrier.id, target.caller.runId);
      const result = yield* callNotes(
        harness,
        { threadId: target.caller.threadId, runId: carrier.id },
        remember(target, fridays, "remember that I deploy on Fridays"),
      );
      assert.notStrictEqual(result.outcome, "saved");
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("naming an earlier input is judged by that input's sender and text", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const turn = yield* lookTurn(harness, "remember that releases are on Fridays", "first");
      yield* followUp(
        harness,
        turn.task.taskId,
        "also remember that staging is staging-02",
        "more",
      );
      const borrowed = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, "Staging is staging-02.", "remember that staging is staging-02"),
      );
      assert.strictEqual(borrowed.reason, "quote_not_in_input");
      const own = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, "Releases are on Fridays.", "remember that releases are on Fridays"),
      );
      assert.strictEqual(own.outcome, "saved");
      assert.include(yield* readNotes, "Releases are on Fridays. (asked in " + turn.inputId + ")");
      assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteNotSaved]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("remember is refused while a notes edit is granted", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const tidy = yield* lookTurn(harness, "tidy my notes", "tidy");
      const other = yield* lookTurn(harness, "remember that staging is staging-02", "other");
      assert.strictEqual(
        (yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"))).outcome,
        "granted",
      );
      // The tidy turn's run ended but its task is still open, so the next run starts.
      harness.world.setStatus(tidy.caller.threadId, 1, "completed");
      const before = yield* readNotes;
      const result = yield* callNotes(
        harness,
        other.caller,
        remember(other, "Staging is staging-02.", "remember that staging is staging-02"),
      );
      assert.strictEqual(result.reason, "busy");
      assert.strictEqual(yield* readNotes, before);
      assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteEditBusy]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the granted task's own other remember is refused, not folded into its edit", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const tidy = yield* lookTurn(harness, "tidy my notes", "tidy");
      yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"));
      const more = yield* followUp(
        harness,
        tidy.task.taskId,
        "also remember that staging is staging-02",
        "more",
      );
      const result = yield* callNotes(harness, tidy.caller, {
        ...remember(tidy, "Staging is staging-02.", "remember that staging is staging-02"),
        inputId: more.inputId,
      });
      assert.strictEqual(result.reason, "busy");
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a follow-up asking to tidy while another input holds the grant is refused busy",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const forget = yield* lookTurn(harness, "forget the deploy note", "forget");
        yield* callNotes(harness, forget.caller, edit(forget, "forget the deploy note"));
        const more = yield* followUp(harness, forget.task.taskId, "also tidy my notes", "more");
        const result = yield* callNotes(harness, forget.caller, {
          ...edit(forget, "tidy my notes"),
          inputId: more.inputId,
        });
        assert.strictEqual(result.reason, "busy");
        const task = yield* (yield* ChannelLedger.ChannelLedger).getTask(forget.task.taskId);
        assert.strictEqual(task?.task.notesChangeRequested, "forget the deploy note");
        assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteEditBusy]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("an edit is granted once, and a repeated call for the same input adds no event", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const tidy = yield* sessionTurn(harness, "tidy my notes", "tidy");
      assert.strictEqual(
        (yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"))).outcome,
        "granted",
      );
      assert.strictEqual(
        (yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"))).outcome,
        "granted",
      );
      const events = yield* (yield* SqlClient.SqlClient)<{ readonly count: number }>`
        SELECT count(*) AS count FROM channel_task_events
        WHERE task_id = ${tidy.task.taskId} AND type = 'task.notes_change_requested'`;
      assert.strictEqual(events[0]!.count, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a refusal notice is queued once and is sent after a restart and a failed attempt",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* writeNotes(NOTES_HEADER);
        // Reception already sent this turn's receipt; on a session-first turn the outbox would send
        // the notice after the turn's answer, keeping one task's messages in order.
        const turn = yield* lookTurn(harness, "remember that I deploy on Fridays", "quote");
        const args = remember(turn, fridays, "words the person never wrote");
        assert.isTrue((yield* callNotes(harness, turn.caller, args)).told);
        yield* callNotes(harness, turn.caller, args);
        assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteNotSaved]);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const owner = runtime.ownerToken;
        const now = DateTime.formatIso(yield* DateTime.now);
        const noticeId = deliveryIdFor(
          "note-request:" + turn.inputId + ":remember:quote_not_in_input",
        );
        const claimNotice = Effect.map(
          ledger.claimDueDeliveries({ owner, now, limit: 50 }),
          (claimed) => claimed.find((row) => row.deliveryId === noticeId),
        );
        // The server stopped while the notice was being sent, then the next attempt failed.
        assert.isDefined(yield* claimNotice);
        yield* ledger.settleInterruptedDeliveries({ owner, now });
        const retried = yield* claimNotice;
        assert.isDefined(retried);
        yield* ledger.recordDelivery({
          owner,
          deliveryId: retried!.deliveryId,
          attempt: retried!.attempts,
          now,
          outcome: { type: "retry", at: now, errorCode: "transport_unavailable" },
        });
        yield* runtime.drain;
        const state = yield* (yield* SqlClient.SqlClient)<{ readonly state: string }>`
        SELECT state FROM channel_outbox WHERE cause_key LIKE 'note-request:%'`;
        assert.deepStrictEqual(
          state.map((row) => row.state),
          ["delivered"],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a forwarded Memory tab forget refused during a grant is put back after it", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const kept = line(fridays, "earlier");
      yield* writeNotes(NOTES_HEADER + kept + "\n");
      const tidy = yield* lookTurn(harness, "tidy my notes", "tidy");
      yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"));
      const sentence = goatBotForgetNoteMessage(fridays);
      const more = yield* followUp(harness, tidy.task.taskId, sentence, "more");
      const result = yield* callNotes(harness, tidy.caller, {
        ...edit(tidy, sentence),
        inputId: more.inputId,
      });
      assert.strictEqual(result.reason, "busy");
      // The tidy turn carries out the refused forget anyway, then finishes.
      yield* writeNotes(NOTES_HEADER);
      harness.world.setStatus(tidy.caller.threadId, 1, "completed");
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual((yield* ledger.getTask(tidy.task.taskId))?.task.status, "completed");
      assert.strictEqual(yield* readNotes, NOTES_HEADER + kept + "\n");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a later refusal for a new reason posts its own notice", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const tidy = yield* lookTurn(harness, "tidy my notes", "tidy");
      const other = yield* lookTurn(harness, "remember that staging is staging-02", "other");
      yield* callNotes(harness, tidy.caller, edit(tidy, "tidy my notes"));
      harness.world.setStatus(tidy.caller.threadId, 1, "completed");
      const misquoted = yield* callNotes(
        harness,
        other.caller,
        remember(other, "Staging is staging-02.", "words the person never wrote"),
      );
      assert.strictEqual(misquoted.reason, "quote_not_in_input");
      const busy = yield* callNotes(
        harness,
        other.caller,
        remember(other, "Staging is staging-02.", "remember that staging is staging-02"),
      );
      assert.strictEqual(busy.reason, "busy");
      assert.deepStrictEqual(yield* notices, [
        CHANNEL_COPY.noteNotSaved,
        CHANNEL_COPY.noteEditBusy,
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("an edit for a finished task posts the task-done notice", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const turn = yield* sessionTurn(harness, "tidy my notes", "tidy");
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(turn.task.taskId))!,
        { type: "task.completed", payload: { generation: turn.task.generation, summary: "Done" } },
        { owner: (yield* ChannelRuntime.ChannelRuntime).ownerToken },
      );
      const result = yield* callNotes(harness, turn.caller, edit(turn, "tidy my notes"));
      assert.strictEqual(result.reason, "task_finished");
      assert.deepStrictEqual(yield* notices, [CHANNEL_COPY.noteEditTaskDone]);
    }).pipe(Effect.provide(harness.layer));
  });

  const memoryUpdated = Effect.gen(function* () {
    yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
    const records = yield* botMessages;
    return records.turnItems.flatMap((item) =>
      item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
    );
  });

  it.effect(
    "a Slack session remember leaves one Memory updated line and a repeat leaves it one",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        yield* writeNotes(NOTES_HEADER);
        const ingested = yield* (yield* ChannelGateway.ChannelGateway).ingest(
          slackInput("remember that I deploy on Fridays", "slack-session"),
          slackContext,
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        const turn = yield* boundTurn(harness, ingested.inputId);
        const saved = yield* callNotes(
          harness,
          turn.caller,
          remember(turn, fridays, "remember that I deploy on Fridays"),
        );
        assert.strictEqual(saved.outcome, "saved");
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);
        const again = yield* callNotes(
          harness,
          turn.caller,
          remember(turn, fridays, "remember that I deploy on Fridays"),
        );
        assert.strictEqual(again.outcome, "saved");
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a remember from the GOAT app and a refused one leave no Memory updated line", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER);
      const turn = yield* sessionTurn(harness, "remember that I deploy on Mondays", "goat-session");
      const saved = yield* callNotes(
        harness,
        turn.caller,
        remember(turn, "I deploy on Mondays.", "remember that I deploy on Mondays"),
      );
      assert.strictEqual(saved.outcome, "saved");
      const refused = yield* callNotes(harness, turn.caller, {
        ...remember(turn, fridays, "not in this message"),
        inputId: turn.inputId,
      });
      assert.strictEqual(refused.outcome, "refused");
      assert.deepStrictEqual(yield* memoryUpdated, []);
    }).pipe(Effect.provide(harness.layer));
  });
});
