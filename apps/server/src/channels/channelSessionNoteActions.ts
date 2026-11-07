/**
 * Notes changes a GOAT Bot session turn asks for on a person's behalf. The model decides that a
 * message asks for one; this service decides whether it may happen: the calling run must carry
 * that person's message, the person must be linked now, and the quote must be in their message.
 */
import {
  ChannelGatewayError,
  ChannelTaskEvent,
  type ChannelInputId,
  type ChannelTaskId,
  type ChannelTaskStatus,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { isUnlinkedPrincipal } from "./ChannelGateway.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import { quotedFromInput } from "./channelBotNotes.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { currentRequester } from "./channelDispatchAuthority.ts";
import { deliveryIdFor, toolSteerIdsFor, turnSteerIdsFor } from "./channelIds.ts";
import { prepareTransition } from "./channelTaskWrites.ts";

type Caller = { readonly threadId: ThreadId; readonly runId: RunId };
type Failure = ChannelGatewayError | ChannelLedger.ChannelLedgerError;

export interface NotesChangeRequest {
  readonly caller: Caller | undefined;
  readonly taskId: ChannelTaskId;
  readonly inputId: ChannelInputId;
  readonly kind: "remember" | "edit";
  readonly quote: string;
  readonly note?: string | undefined;
  readonly replaces?: string | undefined;
}

export type NotesChangeRefusal =
  | "busy"
  | "not_allowed"
  | "quote_not_in_input"
  | "task_finished"
  | "not_saved";

export interface NotesChangeResult {
  readonly outcome: "saved" | "granted" | "refused";
  readonly reason?: NotesChangeRefusal | "correction_unmatched" | undefined;
  /** A fixed notice to the person was queued; the model must not say otherwise. */
  readonly told: boolean;
  readonly message: string;
}

export class ChannelSessionNoteActions extends Context.Service<
  ChannelSessionNoteActions,
  {
    readonly change: (request: NotesChangeRequest) => Effect.Effect<NotesChangeResult, Failure>;
  }
>()("goat/channels/channelSessionNoteActions") {}

const OPEN: ReadonlyArray<ChannelTaskStatus> = [
  "received",
  "dispatching",
  "running",
  "waiting_input",
];
// Only a run that is working can call a tool; a queued or finished run never acts.
const ACTIVE_RUN = new Set(["starting", "running", "waiting"]);
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const fail = (reason: "forbidden" | "not_found" | "invalid_input") =>
  new ChannelGatewayError({ reason });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const writer = yield* ChannelBotNoteWriter;
  const dbError = (cause: unknown) =>
    new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail: "session notes", cause });

  /**
   * The task and the person's message the call acts for. The run must be working and carry one
   * of the task's own messages for its current generation: the request that started it, or a
   * person's follow-up steered into it. A follow-up a tool wrote (actor "agent") never counts.
   */
  const bind = Effect.fn("ChannelSessionNoteActions.bind")(function* (
    caller: Caller | undefined,
    taskId: ChannelTaskId,
    inputId: ChannelInputId,
  ) {
    if (caller === undefined) return yield* fail("forbidden");
    const sessions = yield* sql<{ readonly conversation_id: string }>`
      SELECT conversation_id FROM channel_bot_sessions
      WHERE thread_id = ${caller.threadId} AND state != 'retired'
    `.pipe(Effect.mapError(dbError));
    const session = sessions[0];
    if (session === undefined) return yield* fail("forbidden");
    const stored = yield* ledger.getTask(taskId);
    if (stored === undefined || stored.task.conversationId !== session.conversation_id)
      return yield* fail("not_found");
    const intents = yield* sql<{ readonly message_id: string; readonly kind: string }>`
      SELECT message_id, kind FROM channel_bot_session_runs
      WHERE thread_id = ${caller.threadId} AND task_id = ${taskId}
        AND task_generation = ${stored.task.generation}
    `.pipe(Effect.mapError(dbError));
    const records = yield* threads
      .getThreadRecords(caller.threadId, ["runs", "messages"], {
        runIds: [caller.runId],
        messageRunIds: [caller.runId],
      })
      .pipe(Effect.mapError(dbError));
    const run = records.runs.find((candidate) => candidate.id === caller.runId);
    if (run === undefined || !ACTIVE_RUN.has(run.status)) return yield* fail("forbidden");
    const carried = new Set<string>([
      run.userMessageId,
      ...records.messages
        .filter((message) => message.role === "user" && message.runId === caller.runId)
        .map((message) => message.id),
    ]);
    const carriedIntents = intents.filter((row) => carried.has(row.message_id));
    const ownRequest =
      inputId === stored.task.originInputId &&
      carriedIntents.some((row) => row.kind === "launch" || row.kind === "task");
    if (ownRequest) return stored;
    const followUps = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM channel_task_events
      WHERE task_id = ${taskId} AND type = 'task.followup.received'
    `.pipe(Effect.mapError(dbError));
    const followUpIds = new Set(
      carriedIntents.filter((row) => row.kind === "followup").map((row) => row.message_id),
    );
    const personFollowUp = followUps
      .map((row) => decodeEvent(row.event_json))
      .some((event) => {
        if (
          event.type !== "task.followup.received" ||
          event.actor !== "user" ||
          event.payload.inputId !== inputId ||
          event.payload.generation !== stored.task.generation
        )
          return false;
        const key = event.payload.forwardKey;
        return (["first", "queued"] as const).some((attempt) =>
          followUpIds.has(
            (key === undefined
              ? turnSteerIdsFor(event.payload.inputId, attempt)
              : toolSteerIdsFor(key, attempt)
            ).messageId,
          ),
        );
      });
    if (!personFollowUp) return yield* fail("not_found");
    return stored;
  });

  return ChannelSessionNoteActions.of({
    change: Effect.fn("ChannelSessionNoteActions.change")(function* (request) {
      const stored = yield* bind(request.caller, request.taskId, request.inputId);
      const input = yield* ledger.getInput(request.inputId);
      if (
        input === undefined ||
        input.requester === undefined ||
        input.message.intent !== "message"
      )
        return yield* fail("not_found");
      const message = input.message;
      const now = DateTime.formatIso(yield* DateTime.now);
      // Queued with the outbox's retries before the model hears back: once per request, kind and
      // reason, so a retried call adds nothing and a call refused for a new reason says so.
      const notify = Effect.fn("ChannelSessionNoteActions.notify")(function* (
        reason: NotesChangeRefusal | "correction_unmatched",
        text: string,
      ) {
        const causeKey = "note-request:" + request.inputId + ":" + request.kind + ":" + reason;
        const deliveryId = deliveryIdFor(causeKey);
        yield* ledger.enqueueDeliveries(
          [
            {
              deliveryId,
              causeKey,
              taskId: stored.task.taskId,
              message: {
                deliveryId,
                destination: stored.task.originAddress,
                kind: "receipt",
                text,
                taskId: stored.task.taskId,
              },
            },
          ],
          now,
        );
      });
      const refuse = Effect.fn("ChannelSessionNoteActions.refuse")(function* (
        reason: NotesChangeRefusal,
        text: string,
      ) {
        yield* notify(reason, text);
        const result: NotesChangeResult = {
          outcome: "refused",
          reason,
          told: true,
          message: "Not changed. GOAT told the person: " + text,
        };
        return result;
      });

      const who = yield* currentRequester(input.requester, message.connectionId).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
      );
      if (who === undefined || who.originKind === "mcp" || isUnlinkedPrincipal(who.principalId))
        return yield* refuse("not_allowed", CHANNEL_COPY.noteEditNotAllowed);
      if (!quotedFromInput(request.quote, message.text))
        return yield* refuse("quote_not_in_input", CHANNEL_COPY.noteNotSaved);

      // One notes change at a time covers only its own request; anything else waits.
      const holdsFor = (task: ChannelLedger.ChannelStoredTask["task"]) =>
        task.notesChangeRequested === undefined
          ? undefined
          : (task.notesChangeInputId ?? task.originInputId);
      const sameGrant = (task: ChannelLedger.ChannelStoredTask["task"]) =>
        request.kind === "edit" &&
        task.taskId === request.taskId &&
        holdsFor(task) === request.inputId;

      for (let attempt = 0; attempt < 2; attempt++) {
        const latest = (yield* ledger.getTask(request.taskId)) ?? stored;
        // The run carries the generation it was bound to; a retry since then is new work.
        if (latest.task.generation !== stored.task.generation || !OPEN.includes(latest.task.status))
          return yield* refuse("task_finished", CHANNEL_COPY.noteEditTaskDone);
        if (sameGrant(latest.task)) {
          const granted: NotesChangeResult = {
            outcome: "granted",
            told: false,
            message: grantedMessage(latest.task.notesChangeRequested ?? request.quote),
          };
          return granted;
        }
        const holder = (yield* ledger.listTasksByStatus(OPEN)).find(
          (open) => holdsFor(open.task) !== undefined,
        );
        if (holder !== undefined) return yield* refuse("busy", CHANNEL_COPY.noteEditBusy);
        if (request.kind === "remember") {
          const note = request.note?.trim() ?? "";
          if (note === "") return yield* fail("invalid_input");
          // Checked again under the writer's lock: the task may have moved on while it waited.
          const written = yield* writer.saveIf(
            Effect.gen(function* () {
              const current = (yield* ledger.getTask(request.taskId)) ?? latest;
              if (
                current.task.generation !== stored.task.generation ||
                !OPEN.includes(current.task.status)
              )
                return "task_finished" as const;
              const held = (yield* ledger.listTasksByStatus(OPEN)).some(
                (open) => holdsFor(open.task) !== undefined,
              );
              return held ? ("busy" as const) : undefined;
            }),
            note,
            now,
            request.inputId,
            request.replaces,
          );
          if ("refused" in written)
            return written.refused === "busy"
              ? yield* refuse("busy", CHANNEL_COPY.noteEditBusy)
              : yield* refuse("task_finished", CHANNEL_COPY.noteEditTaskDone);
          const notice = written.notice;
          if (notice === CHANNEL_COPY.noteNotSaved)
            return yield* refuse("not_saved", CHANNEL_COPY.noteNotSaved);
          if (notice !== undefined) {
            yield* notify("correction_unmatched", notice);
            const unmatched: NotesChangeResult = {
              outcome: "saved",
              reason: "correction_unmatched",
              told: true,
              message:
                "Saved, but the note it corrects was not found. GOAT told the person: " + notice,
            };
            return unmatched;
          }
          const saved: NotesChangeResult = {
            outcome: "saved",
            told: false,
            message: "Saved. It applies to later requests.",
          };
          return saved;
        }
        const prepared = prepareTransition(
          latest,
          {
            type: "task.notes_change_requested",
            payload: {
              generation: latest.task.generation,
              quote: request.quote.trim(),
              inputId: request.inputId,
            },
          },
          now,
          undefined,
          { actor: "agent" },
        );
        if (!prepared.ok) return yield* fail("invalid_input");
        const applied = yield* ledger
          .applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries })
          .pipe(
            Effect.as(true),
            Effect.catchIf(
              (error) => error.reason === "version_conflict",
              () => Effect.succeed(false),
            ),
          );
        if (applied) {
          const granted: NotesChangeResult = {
            outcome: "granted",
            told: false,
            message: grantedMessage(request.quote.trim()),
          };
          return granted;
        }
      }
      return yield* new ChannelLedger.ChannelLedgerError({
        reason: "version_conflict",
        detail: "The task kept changing while its notes change was recorded.",
      });
    }),
  });
});

const grantedMessage = (quote: string) =>
  "Allowed: edit the notes file now to make exactly this change and nothing else: " +
  JSON.stringify(quote);

export const layer = Layer.effect(ChannelSessionNoteActions, make);
