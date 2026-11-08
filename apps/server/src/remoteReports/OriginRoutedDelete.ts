import {
  CommandId,
  OrchestratorMcpFailure,
  OriginBoundDeleteResult,
  type OriginBoundDeleteResult as OriginBoundDeleteOutcome,
  type ThreadId,
} from "@goat/contracts";
import { fromToolResult } from "@goat/contracts/agentSurface/envelope";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema } from "effect/ai";

import { LifecycleAdmissionReceipt } from "../mcp/LifecycleAdmissionReceipt.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as HostToolAuthorization from "../mcp/HostToolAuthorization.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { KEY_LIFETIME_HOURS } from "../mcp/ToolAdmission.ts";
import * as ToolAdmission from "../mcp/ToolAdmission.ts";
import { refusalResult } from "../mcp/toolRefusals.ts";
import { unavailable } from "../mcp/threadAccess.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { SshRemoteDispatchError } from "../sshRemote/dispatchFailure.ts";
import * as RemoteDispatchCoordinator from "./RemoteDispatchCoordinator.ts";

const DEFINITE_REMOTE_CODES = new Set([
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "thread_not_found",
  "capability_denied",
  "invalid_request",
  "conflict",
]);

const ResultJson = Schema.fromJsonString(Schema.toCodecJson(McpSchema.CallToolResult));
const encodeResult = Schema.encodeEffect(ResultJson);
const LiteralJson = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
);
const encodeLiteral = Schema.encodeEffect(LiteralJson);
const decodeOutcome = Schema.decodeUnknownEffect(OriginBoundDeleteResult);
const GrantCorrelation = Schema.fromJsonString(
  Schema.Struct({ correlationId: Schema.optionalKey(Schema.String) }),
);
const decodeGrantCorrelation = Schema.decodeUnknownOption(GrantCorrelation);
const isSshError = (error: unknown): error is SshRemoteDispatchError =>
  error instanceof SshRemoteDispatchError;

type Literal = { readonly _tag: string; readonly code?: string };
type Receipt = {
  readonly state: "completed" | "in_progress" | "unknown" | "missing";
  readonly commandStatus?: "accepted" | "rejected" | null;
  readonly result?: McpSchema.CallToolResult;
  readonly failure?: Literal;
  readonly receiptId?: string;
};

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const uncertain = (message: string) =>
  new OrchestratorMcpFailure({
    code: "host_unavailable",
    reason: "ssh_failed",
    mayHaveStarted: true,
    message,
  });

const claimMessage = (
  claim:
    | { readonly _tag: "missing" }
    | { readonly _tag: "reports" }
    | { readonly _tag: "state"; readonly state: string }
    | { readonly _tag: "other_key" },
) => {
  switch (claim._tag) {
    case "missing":
      return "This caller has no launch of that thread on that host, so nothing was deleted.";
    case "reports":
      return "That launch cannot be deleted from here because the host did not support reports, so nothing was deleted.";
    case "other_key":
      return "A different delete request is already in progress for that launch, so this call did not run.";
    case "state":
      return `That launch is ${claim.state}, so its thread was not deleted. Delete it once the launch is idle, settled, or cancelled.`;
  }
};

const okResult = (payload: {
  readonly accepted: true;
  readonly commandId: string;
  readonly sequence: number;
}) =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

const definiteRemoteRefusal = (error: SshRemoteDispatchError) =>
  error.reason === "remote_outdated" ||
  error.reason === "caller_changed" ||
  error.reason === "host_unknown" ||
  (error.reason === "remote_refused" &&
    (error.remoteCode === undefined
      ? error.message.startsWith("The link to ") || error.message.includes("too old to limit")
      : DEFINITE_REMOTE_CODES.has(error.remoteCode)));

export class OriginRoutedDelete extends Context.Service<
  OriginRoutedDelete,
  {
    readonly delete: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly threadId: ThreadId; readonly host: string },
    ) => Effect.Effect<
      { readonly accepted: true; readonly commandId: CommandId; readonly sequence: number },
      OrchestratorMcpFailure
    >;
    readonly receipt: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly clientRequestId: string; readonly host: string },
    ) => Effect.Effect<Receipt, OrchestratorMcpFailure>;
  }
>()("goat/remoteReports/OriginRoutedDelete") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const readReceipt = yield* ToolAdmission.makeReceiptReader();
  const complete = Effect.fn("OriginRoutedDelete.complete")(function* (
    receiptId: string,
    result: McpSchema.CallToolResult,
    failure?: Literal,
  ) {
    const now = yield* DateTime.now;
    const envelope = fromToolResult(result, { effect: "destructive" });
    const outcome = envelope.status === "error" ? envelope.error.code : envelope.status;
    yield* sql`UPDATE mcp_request_reservations SET state = 'completed',
      result_json = ${yield* encodeResult(result)},
      failure_json = ${failure === undefined ? null : yield* encodeLiteral(failure)},
      outcome_code = ${outcome},
      completed_at = ${DateTime.formatIso(now)},
      expires_at = ${DateTime.formatIso(DateTime.add(now, { hours: KEY_LIFETIME_HOURS }))}
      WHERE receipt_id = ${receiptId} AND state != 'completed'`.pipe(Effect.mapError(unavailable));
  });
  const remote = Effect.fn("OriginRoutedDelete.remote")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    host: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) {
    const ssh = yield* Effect.serviceOption(SshRemoteDispatch.SshRemoteDispatch);
    if (Option.isNone(ssh))
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Remote thread deletion is unavailable.",
      });
    return yield* ssh.value.callHostTool(
      { host, tool, arguments: args, writes: true, timeoutMs: 60_000 },
      HostToolAuthorization.authorize(true).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      ),
    );
  });
  const coordinator = Effect.fnUntraced(function* () {
    const service = yield* Effect.serviceOption(
      RemoteDispatchCoordinator.RemoteDispatchCoordinator,
    );
    if (Option.isNone(service))
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Remote thread deletion is unavailable.",
      });
    return service.value;
  });
  const finish = Effect.fn("OriginRoutedDelete.finish")(function* (
    dispatch: RemoteDispatchCoordinator.RemoteDispatchCoordinator["Service"],
    correlationId: string,
    requestKey: string,
    outcome: OriginBoundDeleteOutcome,
  ) {
    if (outcome._tag === "accepted")
      return { accepted: true as const, commandId: outcome.commandId, sequence: outcome.sequence };
    yield* dispatch.clearDelete(correlationId, requestKey).pipe(Effect.mapError(unavailable));
    return yield* refused(outcome.message);
  });
  const failRemote = Effect.fn("OriginRoutedDelete.failRemote")(function* (
    dispatch: RemoteDispatchCoordinator.RemoteDispatchCoordinator["Service"],
    correlationId: string,
    requestKey: string,
    error: unknown,
  ) {
    if (!isSshError(error))
      return yield* uncertain("The host stopped answering; the delete outcome is unknown.");
    if (error.reason === "remote_outdated") {
      yield* dispatch.clearDelete(correlationId, requestKey).pipe(Effect.mapError(unavailable));
      return yield* refused(error.message);
    }
    if (definiteRemoteRefusal(error))
      yield* dispatch.clearDelete(correlationId, requestKey).pipe(Effect.mapError(unavailable));
    return yield* uncertain(error.message);
  });
  const remove = Effect.fn("OriginRoutedDelete.delete")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: { readonly threadId: ThreadId; readonly host: string },
  ) {
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "goat_thread_delete");
    yield* McpToolAccess.admit(input);
    const held = yield* Effect.serviceOption(LifecycleAdmissionReceipt);
    const receiptId = Option.isNone(held) ? undefined : yield* held.value.held;
    if (receiptId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        reason: "storage_failed",
        message: "GOAT could not record this delete, so it did not run.",
      });
    const [reserved] = yield* sql<{ readonly key: string }>`SELECT client_request_id AS "key"
      FROM mcp_request_reservations WHERE receipt_id = ${receiptId}`.pipe(
      Effect.mapError(unavailable),
    );
    if (reserved === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        reason: "storage_failed",
        message: "GOAT could not record this delete, so it did not run.",
      });
    const dispatch = yield* coordinator();
    const claim = yield* dispatch
      .claimDelete({
        originThreadId: caller.thread.threadId,
        host: input.host,
        remoteThreadId: input.threadId,
        requestKey: reserved.key,
      })
      .pipe(Effect.mapError(unavailable));
    if (claim._tag !== "claimed") return yield* refused(claimMessage(claim));
    if (Option.isSome(held))
      yield* held.value
        .correlate(claim.correlationId)
        .pipe(
          Effect.tapError(() =>
            dispatch.clearDelete(claim.correlationId, reserved.key).pipe(Effect.ignoreCause),
          ),
        );
    const called = yield* remote(scope, input.host, "goat_origin_bound_delete", {
      correlationId: claim.correlationId,
      readKey: claim.readKey,
      threadId: input.threadId,
      requestKey: reserved.key,
    }).pipe(Effect.result);
    if (called._tag === "Failure")
      return yield* failRemote(dispatch, claim.correlationId, reserved.key, called.failure);
    const decoded = yield* decodeOutcome(called.success).pipe(Effect.mapError(unavailable));
    return yield* finish(dispatch, claim.correlationId, reserved.key, decoded);
  });
  const read = Effect.fn("OriginRoutedDelete.receipt")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: { readonly clientRequestId: string; readonly host: string },
  ) {
    const caller = yield* McpInvocationContext.requireThreadScope(
      scope,
      "goat_thread_lifecycle_receipt",
    );
    const record = yield* readReceipt("thread.delete", input.clientRequestId).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      Effect.mapError((error) => (error._tag === "OrchestratorMcpFailure" ? error : unavailable())),
    );
    if (!("receiptId" in record) || record.state !== "unknown") return record;
    const [reserved] = yield* sql<{ readonly host: string | null; readonly grant_json: string }>`
      SELECT host AS "host", grant_json AS "grant_json" FROM mcp_request_reservations
      WHERE receipt_id = ${record.receiptId}`.pipe(Effect.mapError(unavailable));
    if (reserved === undefined) return { state: "missing" as const };
    if (reserved.host !== input.host)
      return yield* new OrchestratorMcpFailure({
        code: "conflict",
        reason: "idempotency_mismatch",
        message: `clientRequestId ${input.clientRequestId} was already used for goat_thread_delete with another host, so this call did not run.`,
      });
    const grant = decodeGrantCorrelation(reserved.grant_json);
    const correlationId = grant._tag === "Some" ? grant.value.correlationId : undefined;
    const [dispatchRow] = yield* sql<{
      readonly correlation_id: string;
      readonly read_key: string;
      readonly remote_thread_id: string | null;
    }>`SELECT correlation_id, read_key, remote_thread_id FROM remote_dispatches
      WHERE origin_thread_id = ${caller.thread.threadId} AND host = ${input.host}
        AND (correlation_id = ${correlationId ?? ""} OR delete_request_key = ${input.clientRequestId})
      ORDER BY updated_at DESC LIMIT 1`.pipe(Effect.mapError(unavailable));
    if (dispatchRow?.remote_thread_id == null)
      return { state: "unknown" as const, receiptId: record.receiptId };
    const dispatch = yield* coordinator();
    const called = yield* remote(scope, input.host, "goat_origin_bound_delete_receipt", {
      correlationId: dispatchRow.correlation_id,
      readKey: dispatchRow.read_key,
      threadId: dispatchRow.remote_thread_id,
      requestKey: input.clientRequestId,
    }).pipe(Effect.result);
    if (called._tag === "Failure") {
      if (isSshError(called.failure) && definiteRemoteRefusal(called.failure))
        yield* dispatch
          .clearDelete(dispatchRow.correlation_id, input.clientRequestId)
          .pipe(Effect.mapError(unavailable));
      return { state: "unknown" as const, receiptId: record.receiptId };
    }
    const outcome = yield* decodeOutcome(called.success).pipe(Effect.mapError(unavailable));
    if (outcome._tag === "accepted") {
      const payload = {
        accepted: true as const,
        commandId: outcome.commandId,
        sequence: outcome.sequence,
      };
      const result = okResult(payload);
      yield* complete(record.receiptId, result).pipe(Effect.mapError(unavailable));
      return {
        state: "completed" as const,
        receiptId: record.receiptId,
        result,
        commandStatus: null,
      };
    }
    yield* dispatch
      .clearDelete(dispatchRow.correlation_id, input.clientRequestId)
      .pipe(Effect.mapError(unavailable));
    const failure = { _tag: "OrchestratorMcpFailure", code: "invalid_request" } as const;
    const result = refusalResult(refused(outcome.message));
    yield* complete(record.receiptId, result, failure).pipe(Effect.mapError(unavailable));
    return {
      state: "completed" as const,
      receiptId: record.receiptId,
      result,
      failure,
      commandStatus: null,
    };
  });
  return OriginRoutedDelete.of({ delete: remove, receipt: read });
});

export const layer = Layer.effect(OriginRoutedDelete, make);
