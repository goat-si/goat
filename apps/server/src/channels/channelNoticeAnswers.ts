/**
 * Answers from runs GOAT starts on a GOAT Bot session to say a background command ended. Each
 * goes once, as a reply to the request whose run started the command, and is never that task's
 * result: the task settles on its own runs. One marker per run records sent or skipped.
 */
import type { ChannelTask, OrchestrationV2Run, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../mcp/launchWatch.ts";
import { resolveSessionRun } from "./channelBotSessionRuns.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { replyDelivery } from "./channelReplyDelivery.ts";

/** What the bot answers when a notice has nothing new for the person. */
const NO_REPLY = "NO_REPLY";
const PER_PASS = 20;
const ENDED = ["completed", "failed", "cancelled", "interrupted", "rolled_back"];

/** Ids of the messages GOAT sent about another run's background work. */
export const noticeMessageIds = (
  messages: ReadonlyArray<{
    readonly id: string;
    readonly notification?: { readonly aboutRunId?: string | undefined } | undefined;
  }>,
) =>
  new Set(
    messages.flatMap((message) =>
      message.notification?.aboutRunId === undefined ||
      message.id.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX)
        ? []
        : [message.id],
    ),
  );

const markerKey = (threadId: string, runId: string) => "notice-answer:" + threadId + ":" + runId;

/** A task's runs that can be its result: every owned run but the background command notices. */
export const resultRunsOf = <R extends Pick<OrchestrationV2Run, "userMessageId">>(
  runs: ReadonlyArray<R>,
  notices: ReadonlySet<string>,
) => runs.filter((run) => !notices.has(run.userMessageId));

/** The text a notice answer is sent with: a text channel without threads names the request. */
export const noticeAnswerText = (
  task: Pick<ChannelTask, "title" | "originAddress">,
  text: string,
) =>
  task.originAddress.kind === "goat" || task.originAddress.kind === "slack"
    ? text
    : 'About "' + task.title + '": ' + text;

type Outcome =
  | { readonly state: "sent" }
  | { readonly state: "skipped"; readonly reason: string }
  | { readonly state: "retry"; readonly attempts: number; readonly nextAt: string };

export const deliverNoticeAnswers = Effect.fn("ChannelWorkerReports.noticeAnswers")(
  function* (deps: {
    readonly sql: SqlClient.SqlClient;
    readonly ledger: ChannelLedger.ChannelLedger["Service"];
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
  }) {
    const { sql, ledger, threads } = deps;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    // Oldest first, at any age; a run whose read failed waits for its retry time, so later ones
    // still go. Answered and skipped runs carry a marker and drop out.
    const due = yield* sql<{
      readonly thread_id: ThreadId;
      readonly run_id: string;
      readonly attempts: number | null;
    }>`
    SELECT r.thread_id, r.run_id, json_extract(s.value_json, '$.attempts') AS attempts
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_messages m
      ON m.thread_id = r.thread_id AND m.message_id = json_extract(r.payload_json, '$.userMessageId')
    LEFT JOIN channel_runtime_state s ON s.key = 'notice-answer:' || r.thread_id || ':' || r.run_id
    WHERE r.thread_id >= 'goat-bot-session:' AND r.thread_id < 'goat-bot-session;'
      AND json_extract(m.payload_json, '$.notification.aboutRunId') IS NOT NULL
      AND substr(m.message_id, 1, ${LAUNCH_WATCH_MESSAGE_PREFIX.length}) != ${LAUNCH_WATCH_MESSAGE_PREFIX}
      AND r.status IN ${sql.in(ENDED)}
      AND (s.key IS NULL OR (json_extract(s.value_json, '$.state') = 'retry'
        AND json_extract(s.value_json, '$.nextAt') <= ${nowIso}))
    ORDER BY json_extract(r.payload_json, '$.completedAt'), r.run_id
    LIMIT ${PER_PASS}
  `;
    let sent = 0;
    for (const row of due) {
      const key = markerKey(row.thread_id, row.run_id);
      const judged = yield* judge(threads, sql, ledger, row.thread_id, row.run_id).pipe(
        Effect.result,
      );
      const attempts = (row.attempts ?? 0) + 1;
      const outcome:
        | Outcome
        | { readonly state: "send"; readonly task: ChannelTask; readonly text: string } =
        judged._tag === "Failure"
          ? {
              state: "retry",
              attempts,
              nextAt: DateTime.formatIso(
                DateTime.add(now, { minutes: Math.min(2 ** attempts, 60) }),
              ),
            }
          : judged.success;
      const marker = (value: Outcome) =>
        sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${key}, ${JSON.stringify(value)}, ${nowIso})
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
      if (outcome.state !== "send") {
        yield* marker(outcome);
        continue;
      }
      const delivery = replyDelivery({
        causeKey: key,
        destination: outcome.task.originAddress,
        kind: "result",
        text: noticeAnswerText(outcome.task, outcome.text),
        replyTo: outcome.task.originInputId,
        task: outcome.task,
      });
      const queued = yield* sql.withTransaction(
        Effect.gen(function* () {
          // The request can be stopped or retried after the judgement; check again under the write.
          const fresh = yield* ledger.getTask(outcome.task.taskId);
          if (
            fresh === undefined ||
            fresh.task.status === "cancelled" ||
            fresh.task.generation !== outcome.task.generation
          ) {
            yield* marker({ state: "skipped", reason: "stale" });
            return false;
          }
          yield* ledger.enqueueDeliveries([delivery], nowIso);
          yield* marker({ state: "sent" });
          return true;
        }),
      );
      if (queued) sent += 1;
    }
    return sent;
  },
);

/** Whether one ended notice run has an answer to send, and for which task. Fails on a read error. */
const judge = Effect.fn("ChannelWorkerReports.judgeNoticeAnswer")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  sql: SqlClient.SqlClient,
  ledger: ChannelLedger.ChannelLedger["Service"],
  threadId: ThreadId,
  runId: string,
) {
  const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
  const run: OrchestrationV2Run | undefined = records.runs.find(
    (candidate) => candidate.id === runId,
  );
  if (run === undefined) return { state: "skipped", reason: "no_run" } as const;
  if (run.status !== "completed") return { state: "skipped", reason: run.status } as const;
  const intent = yield* resolveSessionRun(sql, threadId, records, run.id);
  const stored = intent === undefined ? undefined : yield* ledger.getTask(intent.task_id);
  if (stored === undefined || intent === undefined)
    return { state: "skipped", reason: "no_owner" } as const;
  // A stopped request stays stopped; a retried one has newer work answering it.
  if (stored.task.status === "cancelled") return { state: "skipped", reason: "cancelled" } as const;
  if (stored.task.generation !== intent.task_generation)
    return { state: "skipped", reason: "stale" } as const;
  const answers = yield* threads.getThreadRecords(threadId, ["messages"], {
    messageRoles: ["assistant"],
    messageRunIds: [run.id],
  });
  // The run's last word decides: text it wrote on the way is not its answer.
  const text =
    answers.messages
      .filter((message) => !message.streaming)
      .at(-1)
      ?.text.trim() ?? "";
  if (text === "" || text === NO_REPLY) return { state: "skipped", reason: "silent" } as const;
  return { state: "send", task: stored.task, text } as const;
});
