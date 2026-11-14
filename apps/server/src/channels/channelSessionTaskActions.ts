import {
  ChannelGatewayError,
  ChannelTaskEvent,
  type ChannelQuestionId,
  type ChannelTaskId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelLedger from "./ChannelLedger.ts";
import { mayDirect, originConnectionOf } from "./ChannelGateway.ts";
import { canSeeTask } from "./channelBotRecall.ts";
import { senderOf } from "./channelSenderAuthority.ts";
import { requesterForDispatch } from "./channelDispatchAuthority.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import {
  answerForwardIdsFor,
  channelTaskIdFromAgent,
  taskEventIdFor,
  toolForwardKeyFor,
  toolSteerIdsFor,
} from "./channelIds.ts";
import { prepareTransition } from "./channelTaskWrites.ts";

type Caller = { readonly threadId: ThreadId; readonly runId: RunId };
type Common = { readonly caller: Caller; readonly taskId: ChannelTaskId };
type Failure = ChannelGatewayError | ChannelLedger.ChannelLedgerError;
type Result = Effect.Effect<ChannelTaskEvent | null, Failure>;

export class ChannelSessionTaskActions extends Context.Service<
  ChannelSessionTaskActions,
  {
    readonly checkCaller: (caller: Caller | undefined) => Effect.Effect<void, Failure>;
    readonly followUp: (
      input: Common & { readonly text: string; readonly clientRequestId: string },
    ) => Result;
    readonly stop: (input: Common) => Result;
    readonly answer: (
      input: Common & { readonly questionId: ChannelQuestionId; readonly answer: string },
    ) => Result;
  }
>()("goat/channels/channelSessionTaskActions") {}

const fail = (reason: "forbidden" | "not_found" | "invalid_input") =>
  new ChannelGatewayError({ reason });
const withFullTaskId = <I extends Common>(input: I): I => ({
  ...input,
  taskId: channelTaskIdFromAgent(input.taskId),
});
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const dbError = (cause: unknown) =>
    new ChannelLedger.ChannelLedgerError({
      reason: "persistence",
      detail: "session task actions",
      cause,
    });
  const checkCaller = Effect.fn("ChannelSessionTaskActions.checkCaller")(function* (
    caller: Caller | undefined,
  ) {
    if (caller === undefined) return yield* fail("forbidden");
    const rows = yield* sql<{ readonly task_id: ChannelTaskId }>`
      SELECT r.task_id FROM channel_bot_sessions s JOIN channel_bot_session_runs r ON r.thread_id = s.thread_id
      WHERE s.thread_id = ${caller.threadId} AND s.state != 'retired' AND r.run_id = ${caller.runId}
    `.pipe(Effect.mapError(dbError));
    if (rows.length === 0) return yield* fail("forbidden");
  });
  const authorize = Effect.fn("ChannelSessionTaskActions.authorize")(function* (
    input: Common,
    reach: "conversation" | "visible" = "conversation",
  ) {
    const sessions = yield* sql<{
      readonly conversation_id: string;
      readonly requester_json: string;
    }>`
      SELECT conversation_id, requester_json FROM channel_bot_sessions
      WHERE thread_id = ${input.caller.threadId} AND state != 'retired'
    `.pipe(Effect.mapError(dbError));
    const session = sessions[0];
    if (session === undefined) return yield* fail("forbidden");
    const runs = yield* sql<{ readonly task_id: ChannelTaskId; readonly task_generation: number }>`
      SELECT task_id, task_generation FROM channel_bot_session_runs
      WHERE thread_id = ${input.caller.threadId} AND run_id = ${input.caller.runId}
    `.pipe(Effect.mapError(dbError));
    const run = runs[0];
    if (run === undefined) return yield* fail("forbidden");
    const source = yield* ledger.getTask(run.task_id);
    if (source === undefined || source.task.conversationId !== session.conversation_id)
      return yield* fail("forbidden");
    // The run acts for its requester as they stand now, not as their task recorded them.
    const requester = yield* requesterForDispatch(source.task).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );
    if (requester === undefined) return yield* fail("forbidden");
    const connectionId = originConnectionOf(source.task);
    const target = yield* ledger.getTask(input.taskId);
    if (
      target === undefined ||
      target.ownerId !== requester.ownerId ||
      (reach === "visible"
        ? !canSeeTask(requester, target.task, source.task.conversationId)
        : target.task.conversationId !== session.conversation_id) ||
      !mayDirect(requester, connectionId, target.task)
    )
      return yield* fail("not_found");
    return { target, requester, sender: senderOf(requester, connectionId) };
  });
  const findEvent = Effect.fn("ChannelSessionTaskActions.findEvent")(function* (
    taskId: ChannelTaskId,
    type: string,
    field: string,
    value: string,
  ) {
    const rows = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM channel_task_events WHERE task_id = ${taskId} AND type = ${type}
      AND json_extract(event_json, ${"$.payload." + field}) = ${value} LIMIT 1
    `.pipe(Effect.mapError(dbError));
    return rows[0] === undefined ? undefined : decodeEvent(rows[0].event_json);
  });
  return ChannelSessionTaskActions.of({
    checkCaller,
    followUp: Effect.fn("ChannelSessionTaskActions.followUp")(function* (agentInput) {
      const input = withFullTaskId(agentInput);
      const { target, requester, sender } = yield* authorize(input);
      const key = toolForwardKeyFor(input.caller.runId, input.taskId, input.clientRequestId);
      const existing = yield* findEvent(input.taskId, "task.followup.received", "forwardKey", key);
      if (existing !== undefined) return existing;
      if (
        target.task.status !== "running" ||
        target.task.worker === undefined ||
        target.task.worker.host !== undefined
      )
        return yield* fail("invalid_input");
      const bot = yield* ledger.getBotById(target.ownerId, target.botId);
      const prepared = prepareTransition(
        target,
        {
          type: "task.followup.received",
          payload: {
            inputId: target.task.originInputId,
            forwardKey: key,
            text: input.text,
            from: requester.displayName,
            generation: target.task.generation,
            sender,
          },
        },
        DateTime.formatIso(yield* DateTime.now),
        bot?.bot,
        {
          actor: "agent",
          forward: true,
          pendingAnswerMessageId: toolSteerIdsFor(key, "first").messageId,
        },
      );
      if (!prepared.ok) return yield* fail("invalid_input");
      return yield* ledger
        .applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries })
        .pipe(
          Effect.as(prepared.event),
          Effect.catchIf(
            (error) => error.reason === "version_conflict",
            (error) =>
              findEvent(input.taskId, "task.followup.received", "forwardKey", key).pipe(
                Effect.filterOrFail(
                  (event) => event !== undefined,
                  () => error,
                ),
              ),
          ),
        );
    }),
    stop: Effect.fn("ChannelSessionTaskActions.stop")(function* (input) {
      // A person may stop any work they can see by asking; their session may stop the same work.
      const { target, requester } = yield* authorize(withFullTaskId(input), "visible");
      if (!["received", "dispatching", "running", "waiting_input"].includes(target.task.status))
        return null;
      const bot = yield* ledger.getBotById(target.ownerId, target.botId);
      const prepared = prepareTransition(
        target,
        {
          type: "task.cancelled",
          payload: { reason: "Stopped by " + requester.displayName + "." },
        },
        DateTime.formatIso(yield* DateTime.now),
        bot?.bot,
        { actor: "agent", narrate: true, forward: true },
      );
      if (!prepared.ok) return yield* fail("invalid_input");
      yield* ledger.applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries });
      return prepared.event;
    }),
    answer: Effect.fn("ChannelSessionTaskActions.answer")(function* (agentInput) {
      const input = withFullTaskId(agentInput);
      const { target, sender } = yield* authorize(input);
      const existing = yield* findEvent(
        input.taskId,
        "task.question.answered",
        "questionId",
        input.questionId,
      );
      if (existing !== undefined) return existing;
      if (!target.task.openQuestions.some((question) => question.questionId === input.questionId))
        return yield* fail("invalid_input");
      // A dispatcher question also needs target selection, which this tool cannot establish.
      if (target.task.worker === undefined) return yield* fail("invalid_input");
      const eventId = taskEventIdFor(target.task.taskId, target.task.version + 1);
      const bot = yield* ledger.getBotById(target.ownerId, target.botId);
      const prepared = prepareTransition(
        target,
        {
          type: "task.question.answered",
          payload: { questionId: input.questionId, answer: input.answer, sender },
        },
        DateTime.formatIso(yield* DateTime.now),
        bot?.bot,
        {
          actor: "agent",
          eventId,
          forward: true,
          pendingAnswerMessageId: answerForwardIdsFor(eventId).messageId,
        },
      );
      if (!prepared.ok) return yield* fail("invalid_input");
      yield* ledger.applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries });
      return prepared.event;
    }),
  });
});
export const layer = Layer.effect(ChannelSessionTaskActions, make);
