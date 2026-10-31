import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { historyTypedText } from "./ComputerUseHistoryText.ts";
import { historyStamp, type HistoryStamp } from "./ComputerUseHistoryStamp.ts";

type Target =
  | { readonly kind: "app"; readonly id?: string; readonly name?: string }
  | { readonly kind: "tab"; readonly host: string };

type HistoryInput = {
  readonly threadId: string;
  readonly stamp?: HistoryStamp;
  readonly reservation?: { readonly id: string; readonly controlId: string };
  readonly target: Target;
  readonly method: string;
  readonly targetLabel?: string;
  readonly verdict: "sent" | "refused" | "unknown_outcome";
  readonly refusalCode?: string;
  readonly typed?: {
    readonly value?: string;
    readonly length?: number;
    readonly field: "normal" | "secure" | "unknown";
    readonly keep: boolean;
  };
};

export interface HistoryEntry {
  readonly id: number;
  readonly threadId: string;
  readonly recordedAt: number;
  readonly orderSeq: number;
  readonly targetKind: "app" | "tab";
  readonly appId: string | null;
  readonly appName: string | null;
  readonly tabHost: string | null;
  readonly method: string;
  readonly targetLabel: string | null;
  readonly verdict: "sent" | "refused" | "unknown_outcome";
  readonly refusalCode: string | null;
  readonly typedLength: number | null;
  readonly typedText: string | null;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const makeComputerUseHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const record = Effect.fn("ComputerUseHistory.record")(function* (entry: HistoryInput) {
    const now = yield* Clock.currentTimeMillis;
    const stamp = entry.stamp ?? historyStamp(now);
    yield* sql`DELETE FROM computer_use_input_history WHERE id IN
      (SELECT id FROM computer_use_input_history WHERE recorded_at < ${now - RETENTION_MS} LIMIT 500)`;
    const input = entry.typed;
    const typed =
      input === undefined
        ? undefined
        : input.value === undefined
          ? { length: input.length ?? 0 }
          : historyTypedText(input.value, input.keep, input.field);
    const typedLength = input?.length ?? typed?.length ?? null;
    const typedText = typed?.length === typedLength ? (typed?.text ?? null) : null;
    yield* sql`INSERT INTO computer_use_input_history
      (thread_id, recorded_at, order_seq, target_kind, app_id, app_name, tab_host, method, target_label, verdict, refusal_code, typed_length, typed_text, reservation_id, control_id)
      VALUES (${entry.threadId}, ${stamp.recordedAt}, ${stamp.orderSeq}, ${entry.target.kind}, ${entry.target.kind === "app" ? (entry.target.id ?? null) : null},
        ${entry.target.kind === "app" ? (entry.target.name ?? null) : null}, ${entry.target.kind === "tab" ? entry.target.host : null},
        ${entry.method}, ${entry.targetLabel ?? null}, ${entry.verdict}, ${entry.refusalCode ?? null}, ${typedLength}, ${typedText},
        ${entry.reservation?.id ?? null}, ${entry.reservation?.controlId ?? null})`;
  });
  const settle = Effect.fn("ComputerUseHistory.settle")(function* (input: {
    readonly threadId: string;
    readonly controlId: string;
    readonly reservationId: string;
    readonly verdict: "sent" | "refused" | "unknown_outcome";
    readonly refusalCode?: string;
    readonly stamp?: HistoryStamp;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const stamp = input.stamp ?? historyStamp(now);
    const rows = yield* sql<{ readonly id: number }>`UPDATE computer_use_input_history
      SET verdict = ${input.verdict}, refusal_code = ${input.verdict === "refused" ? (input.refusalCode ?? null) : null},
        recorded_at = ${stamp.recordedAt}, order_seq = ${stamp.orderSeq}, outcome_reported = 1
      WHERE thread_id = ${input.threadId} AND control_id = ${input.controlId}
        AND reservation_id = ${input.reservationId} AND outcome_reported = 0
      RETURNING id`;
    return rows.length === 1;
  });
  const listForThread = Effect.fn("ComputerUseHistory.listForThread")(function* (
    threadId: string,
    options?: {
      readonly limit?: number;
      readonly before?: {
        readonly recordedAt: number;
        readonly id: number;
        readonly orderSeq?: number;
      };
    },
  ) {
    const limit = Math.max(1, Math.min(100, Math.trunc(options?.limit ?? 100)));
    const beforeTime = options?.before?.recordedAt ?? 0;
    const beforeId = options?.before?.id ?? 0;
    const beforeOrder = options?.before?.orderSeq ?? null;
    const firstPage = options?.before === undefined ? 1 : 0;
    const now = yield* Clock.currentTimeMillis;
    return yield* sql<HistoryEntry>`SELECT id, thread_id AS threadId, recorded_at AS recordedAt, order_seq AS orderSeq,
      target_kind AS targetKind, app_id AS appId, app_name AS appName, tab_host AS tabHost,
      method, target_label AS targetLabel, verdict, refusal_code AS refusalCode,
      typed_length AS typedLength, typed_text AS typedText
      FROM computer_use_input_history WHERE thread_id = ${threadId}
      AND recorded_at >= ${now - RETENTION_MS}
      AND (${firstPage} = 1 OR recorded_at < ${beforeTime} OR (recorded_at = ${beforeTime} AND
        (order_seq < COALESCE(${beforeOrder}, (SELECT order_seq FROM computer_use_input_history WHERE thread_id = ${threadId} AND id = ${beforeId}), 0)
        OR (order_seq = COALESCE(${beforeOrder}, (SELECT order_seq FROM computer_use_input_history WHERE thread_id = ${threadId} AND id = ${beforeId}), 0) AND id < ${beforeId}))))
      ORDER BY recorded_at DESC, order_seq DESC, id DESC LIMIT ${limit}`;
  });
  const prune = Effect.fn("ComputerUseHistory.prune")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM computer_use_input_history WHERE recorded_at < ${now - RETENTION_MS}`;
  });
  return { record, settle, listForThread, prune: prune() };
});
