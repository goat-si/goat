import { CommandId, OrchestratorMcpFailure, ThreadId } from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { isKeyedWrite } from "@goat/contracts/agentSurface/resolve";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { McpSchema } from "effect/ai";

import { refusalResult } from "./toolRefusals.ts";

const KEY_LIFETIME_HOURS = 24;

type Literal = { readonly _tag: string; readonly code?: string };
type UnsettledRow = {
  readonly path: string;
  readonly client_request_id: string;
  readonly receipt_id: string;
  readonly grant_json: string;
};
type CommandReceiptRow = {
  readonly command_id: string;
  readonly aggregate_id: string;
  readonly result_sequence: number;
  readonly status: "accepted" | "rejected";
  readonly error: string | null;
};

const ResultJson = Schema.fromJsonString(Schema.toCodecJson(McpSchema.CallToolResult));
const encodeResult = Schema.encodeEffect(ResultJson);
const LiteralJson = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
);
const encodeLiteral = Schema.encodeEffect(LiteralJson);
const CorrelatedGrantJson = Schema.fromJsonString(
  Schema.Struct({ correlated: Schema.optionalKey(Schema.Literal(true)) }),
);
const decodeCorrelated = Schema.decodeUnknownOption(CorrelatedGrantJson);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isCorrelatedGrant = (grantJson: string): boolean => {
  const opt = decodeCorrelated(grantJson);
  return opt._tag === "Some" && opt.value.correlated === true;
};

const reconcileTargetPaths: ReadonlyMap<string, ReadonlyArray<string>> = (() => {
  const byReconcile = new Map<string, Array<string>>();
  for (const entry of Object.values(agentSurfaceRegistry) as ReadonlyArray<
    AgentSurfaceEntry & { readonly path: string }
  >) {
    if (!isKeyedWrite(entry) || entry.reconcile === undefined) continue;
    const list = byReconcile.get(entry.reconcile) ?? [];
    list.push(entry.path);
    byReconcile.set(entry.reconcile, list);
  }
  return byReconcile;
})();

const readByToolName: ReadonlyMap<string, string> = new Map(
  (
    Object.values(agentSurfaceRegistry) as ReadonlyArray<
      AgentSurfaceEntry & { readonly path: string }
    >
  )
    .filter((entry) => entry.effect === "read")
    .map((entry) => [entry.name, entry.path] as const),
);

export const reconcilePathForReadTool = (tool: string) => readByToolName.get(tool);

const okToolResult = (payload: unknown) =>
  encodeUnknownJson(payload).pipe(
    Effect.map(
      (text) =>
        new McpSchema.CallToolResult({
          isError: false,
          structuredContent: payload as Record<string, unknown>,
          content: [{ type: "text", text }],
        }),
    ),
  );

const LIFECYCLE_PATHS: ReadonlySet<string> = new Set([
  "queue.resume",
  "queued_run.start",
  "thread.delete",
  "provider_session.detach",
]);

/**
 * Resolves whether an unsettled reservation row has a provable domain outcome in durable
 * tables, and updates or deletes the reservation accordingly. Best-effort: database failures
 * during settlement are ignored so the read tool itself still succeeds.
 */
export const settleUnsettledRow = Effect.fn("ToolAdmissionSettlement.settleRow")(function* (
  sql: SqlClient.SqlClient,
  row: UnsettledRow,
) {
  const complete = Effect.fnUntraced(function* (
    result: McpSchema.CallToolResult,
    outcomeCode: string,
    failure?: Literal,
  ) {
    const now = yield* DateTime.now;
    const completedAt = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(DateTime.add(now, { hours: KEY_LIFETIME_HOURS }));
    const resultJson = yield* encodeResult(result);
    const failureJson = failure === undefined ? null : yield* encodeLiteral(failure);
    yield* sql`UPDATE mcp_request_reservations
      SET state = 'completed', result_json = ${resultJson}, failure_json = ${failureJson},
          outcome_code = ${outcomeCode}, completed_at = ${completedAt}, expires_at = ${expiresAt}
      WHERE receipt_id = ${row.receipt_id} AND state != 'completed'`;
  });

  const release = sql`DELETE FROM mcp_request_reservations
    WHERE receipt_id = ${row.receipt_id} AND state != 'completed'`;

  if (LIFECYCLE_PATHS.has(row.path)) {
    const commandId = CommandId.make(`mcp:lifecycle:${row.receipt_id}`);
    const [receipt] = yield* sql<CommandReceiptRow>`
      SELECT command_id, aggregate_id, result_sequence, status, error
      FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
    if (receipt === undefined) {
      yield* release;
      return;
    }
    if (receipt.status === "accepted") {
      const result = yield* okToolResult({
        accepted: true,
        commandId,
        sequence: receipt.result_sequence,
      });
      yield* complete(result, "ok");
      return;
    }
    const failure = new OrchestratorMcpFailure({
      code: "invalid_request",
      message: receipt.error ?? "The command was rejected.",
    });
    yield* complete(refusalResult(failure), "invalid_request", {
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
    });
    return;
  }

  // Writes outside lifecycle only correlate when the reservation recorded correlated: true.
  if (!isCorrelatedGrant(row.grant_json)) return;

  const commandId = CommandId.make(`mcp:${row.receipt_id}`);
  if (row.path === "thread.fork" || row.path === "thread.merge_back") {
    const [receipt] = yield* sql<CommandReceiptRow>`
      SELECT command_id, aggregate_id, result_sequence, status, error
      FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
    if (receipt === undefined) {
      yield* release;
      return;
    }
    if (receipt.status === "accepted") {
      const targetThreadId =
        row.path === "thread.fork"
          ? ThreadId.make(`${commandId}:fork`)
          : ThreadId.make(receipt.aggregate_id);
      const result = yield* okToolResult({
        sequence: receipt.result_sequence,
        targetThreadId,
      });
      yield* complete(result, "ok");
    }
    return;
  }

  if (row.path === "thread.organize") {
    const [receipt] = yield* sql<CommandReceiptRow>`
      SELECT command_id, aggregate_id, result_sequence, status, error
      FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
    if (receipt?.status === "accepted") {
      const result = yield* okToolResult({ sequence: receipt.result_sequence });
      yield* complete(result, "ok");
    }
    return;
  }

  if (row.path === "project.delete") {
    const childPrefix = `${commandId}:delete-thread:%`;
    const rows = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_command_receipts
      WHERE command_id = ${commandId} OR command_id LIKE ${childPrefix} LIMIT 1`;
    if (rows.length === 0) yield* release;
    return;
  }

  if (row.path === "ssh.thread_launch") {
    const correlationId = `rr-${row.receipt_id}`;
    const [dispatch] = yield* sql<{
      readonly state: string;
      readonly last_error: string | null;
    }>`SELECT state, last_error FROM remote_dispatches WHERE correlation_id = ${correlationId}`;
    if (
      dispatch !== undefined &&
      dispatch.state === "cancelled" &&
      dispatch.last_error !== null &&
      dispatch.last_error.includes("fenced")
    ) {
      yield* release;
    }
  }
});

/**
 * Settles any unknown reservations for (environmentId, principal) that reconcile through
 * reconcilePath (or for one specific (path, clientRequestId)).
 */
export const settleForReconcile = Effect.fn("ToolAdmissionSettlement.settleForReconcile")(
  function* (
    sql: SqlClient.SqlClient,
    bootId: string,
    abandoned: ReadonlySet<string>,
    input: {
      readonly environmentId: string;
      readonly principal: string;
      readonly reconcilePath?: string;
      readonly path?: string;
      readonly clientRequestId?: string;
      readonly checkGrant: (grantJson: string) => Effect.Effect<boolean>;
    },
  ) {
    const paths =
      input.path !== undefined
        ? [input.path]
        : input.reconcilePath !== undefined
          ? (reconcileTargetPaths.get(input.reconcilePath) ?? [])
          : [];
    if (paths.length === 0) return;
    const rows = yield* sql<
      UnsettledRow & {
        readonly state: "running" | "completed" | "unknown";
        readonly boot_id: string;
      }
    >`SELECT path, client_request_id, receipt_id, grant_json, state, boot_id
      FROM mcp_request_reservations
      WHERE environment_id = ${input.environmentId} AND principal = ${input.principal}
        AND path IN ${sql.in(paths)}
        AND (${input.clientRequestId ?? null} IS NULL OR client_request_id = ${input.clientRequestId ?? null})
        AND state != 'completed'`;
    for (const row of rows) {
      const isRunningHere =
        row.state === "running" && row.boot_id === bootId && !abandoned.has(row.receipt_id);
      if (isRunningHere) continue;
      const granted = yield* input
        .checkGrant(row.grant_json)
        .pipe(Effect.orElseSucceed(() => false));
      if (!granted) continue;
      yield* settleUnsettledRow(sql, row).pipe(Effect.ignoreCause);
    }
  },
);
