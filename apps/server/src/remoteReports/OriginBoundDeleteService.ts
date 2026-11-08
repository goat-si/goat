// @effect-diagnostics nodeBuiltinImport:off - the request key is hashed like the binding read key.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  isProviderNativeSubagentThread,
  NonNegativeInt,
  OrchestratorMcpFailure,
  type OriginBoundDeleteInput,
  type OriginBoundDeleteResult,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  assertTargetWithinLimits,
  type CallerLimits,
  dispatchFailure,
  unavailable,
} from "../mcp/threadAccess.ts";
import {
  fencedDeleteRefusal,
  McpThreadDeletionPolicy,
} from "../orchestration-v2/goat/McpThreadDeletionPolicy.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const originBoundDeleteCommandId = (correlationId: string, requestKey: string): CommandId =>
  CommandId.make(
    `origin-delete:${correlationId}:${NodeCrypto.createHash("sha256").update(requestKey, "utf8").digest("hex")}`,
  );

const notBound = () =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    classification: "not_bound",
    message: "This read key is not bound to that thread.",
  });

const StoredReceipt = Schema.Struct({
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
  resultSequence: NonNegativeInt,
});
type StoredReceipt = typeof StoredReceipt.Type;
const decodeReceipt = Schema.decodeUnknownEffect(StoredReceipt);
const decodeSequence = Schema.decodeUnknownEffect(NonNegativeInt);

const keysMatch = (supplied: Buffer, storedHex: string) => {
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === supplied.length && NodeCrypto.timingSafeEqual(supplied, stored);
};

const outcome = (commandId: CommandId, receipt: StoredReceipt): OriginBoundDeleteResult =>
  receipt.status === "accepted"
    ? { _tag: "accepted", commandId, sequence: receipt.resultSequence }
    : receipt.error === fencedDeleteRefusal
      ? { _tag: "did_not_run", message: fencedDeleteRefusal }
      : {
          _tag: "refused",
          message:
            receipt.error !== null && receipt.error.length > 0
              ? receipt.error
              : "Previously rejected.",
        };

export class OriginBoundDeleteService extends Context.Service<
  OriginBoundDeleteService,
  {
    readonly delete: (
      input: OriginBoundDeleteInput,
      limits: CallerLimits,
    ) => Effect.Effect<OriginBoundDeleteResult, OrchestratorMcpFailure>;
    readonly receipt: (
      input: OriginBoundDeleteInput,
    ) => Effect.Effect<OriginBoundDeleteResult, OrchestratorMcpFailure>;
  }
>()("goat/remoteReports/OriginBoundDeleteService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const readReceipt = Effect.fn("OriginBoundDeleteService.readReceipt")(function* (
    commandId: CommandId,
  ) {
    const rows = yield* sql<{
      readonly status: string;
      readonly error: string | null;
      readonly resultSequence: number;
    }>`
      SELECT status AS "status", error AS "error", result_sequence AS "resultSequence"
      FROM orchestration_command_receipts
      WHERE command_id = ${commandId}
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return yield* decodeReceipt(row);
  }, Effect.mapError(unavailable));
  const authorize = Effect.fn("OriginBoundDeleteService.authorize")(function* (
    input: OriginBoundDeleteInput,
  ) {
    const rows = yield* sql<{ readonly threadId: ThreadId; readonly readKeyHash: string }>`
      SELECT thread_id AS "threadId", read_key_hash AS "readKeyHash"
      FROM remote_report_bindings
      WHERE correlation_id = ${input.correlationId}
    `.pipe(Effect.mapError(unavailable));
    const binding = rows[0];
    const supplied = NodeCrypto.createHash("sha256").update(input.readKey, "utf8").digest();
    if (
      binding === undefined ||
      !keysMatch(supplied, binding.readKeyHash) ||
      binding.threadId !== input.threadId
    )
      return yield* notBound();
  });
  const dispatchDelete = Effect.fn("OriginBoundDeleteService.dispatch")(function* (
    threadId: ThreadId,
    commandId: CommandId,
    fence: boolean,
  ) {
    return yield* threads.dispatch({ type: "thread.delete", threadId, commandId }).pipe(
      Effect.provideService(McpThreadDeletionPolicy, fence ? { fence: true } : {}),
      Effect.matchEffect({
        onFailure: Effect.fn("OriginBoundDeleteService.replayFailure")(function* (error) {
          if (error._tag === "OrchestratorThreadAboveModeLimitError")
            return yield* new OrchestratorMcpFailure({
              code:
                error.mode === "runtime"
                  ? "runtime_mode_escalation_denied"
                  : "interaction_mode_escalation_denied",
              message: error.message,
            });
          const stored = yield* readReceipt(commandId);
          if (stored !== undefined) return outcome(commandId, stored);
          return yield* dispatchFailure(error);
        }),
        onSuccess: (result) =>
          decodeSequence(result.sequence).pipe(
            Effect.mapError(unavailable),
            Effect.map((sequence): OriginBoundDeleteResult => ({
              _tag: "accepted",
              commandId,
              sequence,
            })),
          ),
      }),
    );
  });
  const settle = Effect.fn("OriginBoundDeleteService.settle")(function* (
    input: OriginBoundDeleteInput,
    fence: boolean,
    limits: CallerLimits | undefined,
  ) {
    yield* authorize(input);
    const commandId = originBoundDeleteCommandId(input.correlationId, input.requestKey);
    const existing = yield* readReceipt(commandId);
    if (existing !== undefined) return outcome(commandId, existing);
    if (!fence) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(unavailable));
      if (shell === null || shell.deletedAt !== null)
        return yield* new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "The target thread was not found.",
        });
      if (limits === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A bound delete needs the caller mode ceiling.",
        });
      yield* assertTargetWithinLimits(limits, shell);
      if (isProviderNativeSubagentThread(shell))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Provider-native subagent threads are read-only.",
        });
    }
    return yield* dispatchDelete(input.threadId, commandId, fence);
  });
  return OriginBoundDeleteService.of({
    delete: Effect.fn("OriginBoundDeleteService.delete")((input, limits) =>
      settle(input, false, limits),
    ),
    receipt: Effect.fn("OriginBoundDeleteService.receipt")((input) =>
      settle(input, true, undefined),
    ),
  });
});

export const layer = Layer.effect(OriginBoundDeleteService, make);
