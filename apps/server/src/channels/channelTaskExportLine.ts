/**
 * Turns one persisted outcome row from `ChannelLedger.exportTasks` into its JSONL export line.
 *
 * @module channelTaskExportLine
 */
import { ChannelTask, ChannelTaskEvent, ChannelTaskLedgerExportRow } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const encodeExportRow = Schema.encodeSync(Schema.fromJsonString(ChannelTaskLedgerExportRow));

export interface ChannelTaskExportSqlRow {
  readonly sequence: number;
  readonly owner_id: string;
  readonly task_json: string;
  readonly event_json: string;
  readonly brief_json: string | null;
  readonly worker_json: string | null;
  readonly human_interventions: number;
  readonly reruns: number;
  /** Retries and moves before the outcome; each starts exactly the next generation. */
  readonly generation_starts: number;
}

export const channelTaskExportLine = (row: ChannelTaskExportSqlRow): string => {
  const task = decodeTask(row.task_json);
  const outcome = decodeEvent(row.event_json);
  const frozen = row.brief_json === null ? undefined : decodeEvent(row.brief_json);
  const bound = row.worker_json === null ? undefined : decodeEvent(row.worker_json);
  const brief = frozen?.type === "task.brief.frozen" ? frozen.payload.brief : null;
  // A cancellation names no generation, so it is derived from the generation starts before it.
  const generation =
    outcome.type === "task.completed" || outcome.type === "task.failed"
      ? outcome.payload.generation
      : row.generation_starts + 1;
  const worker =
    bound?.type === "task.worker.bound" && bound.payload.worker.generation === generation
      ? bound.payload.worker
      : undefined;
  return encodeExportRow({
    sequence: row.sequence,
    taskId: task.taskId,
    ownerId: row.owner_id,
    requester: task.requester,
    conversationId: task.conversationId,
    originBindingId: task.originBindingId,
    originAddress: task.originAddress,
    originInputId: task.originInputId,
    title: task.title,
    brief,
    terminalState:
      outcome.type === "task.completed"
        ? "completed"
        : outcome.type === "task.failed"
          ? "failed"
          : "cancelled",
    occurredAt: outcome.occurredAt,
    resultSummary:
      outcome.type === "task.completed"
        ? outcome.payload.summary
        : outcome.type === "task.failed"
          ? (outcome.payload.summary ?? outcome.payload.reason)
          : outcome.type === "task.cancelled"
            ? (outcome.payload.reason ?? null)
            : null,
    // The ledger stores worker/run pointers and summaries, not transcript evidence.
    evidence: worker ?? null,
    channelAnswers: row.human_interventions,
    reruns: row.reruns,
    generation,
  });
};
