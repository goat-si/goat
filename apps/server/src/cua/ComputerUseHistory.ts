import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { historyTypedText } from "./ComputerUseHistoryText.ts";

type Target =
  | { readonly kind: "app"; readonly id?: string; readonly name?: string }
  | { readonly kind: "tab"; readonly host: string };

type HistoryInput = {
  readonly threadId: string;
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
      (thread_id, recorded_at, target_kind, app_id, app_name, tab_host, method, target_label, verdict, refusal_code, typed_length, typed_text)
      VALUES (${entry.threadId}, ${now}, ${entry.target.kind}, ${entry.target.kind === "app" ? (entry.target.id ?? null) : null},
        ${entry.target.kind === "app" ? (entry.target.name ?? null) : null}, ${entry.target.kind === "tab" ? entry.target.host : null},
        ${entry.method}, ${entry.targetLabel ?? null}, ${entry.verdict}, ${entry.refusalCode ?? null}, ${typedLength}, ${typedText})`;
  });
  const listForThread = Effect.fn("ComputerUseHistory.listForThread")(function* (threadId: string) {
    return yield* sql<HistoryEntry>`SELECT id, thread_id AS threadId, recorded_at AS recordedAt,
      target_kind AS targetKind, app_id AS appId, app_name AS appName, tab_host AS tabHost,
      method, target_label AS targetLabel, verdict, refusal_code AS refusalCode,
      typed_length AS typedLength, typed_text AS typedText
      FROM computer_use_input_history WHERE thread_id = ${threadId} ORDER BY recorded_at DESC, id DESC`;
  });
  const prune = Effect.fn("ComputerUseHistory.prune")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM computer_use_input_history WHERE recorded_at < ${now - RETENTION_MS}`;
  });
  return { record, listForThread, prune: prune() };
});
