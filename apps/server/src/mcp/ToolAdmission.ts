// @effect-diagnostics-next-line nodeBuiltinImport:off -- argument digests and receipt ids need node:crypto.
import * as NodeCrypto from "node:crypto";

import { OrchestratorMcpFailure } from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  declaredFailureLiteral,
  fromToolResult,
  settlementOf,
} from "@goat/contracts/agentSurface/envelope";
import { isKeyedWrite } from "@goat/contracts/agentSurface/resolve";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { refusalResult } from "./toolRefusals.ts";

/** Completed keys live at least this long (docs/internals/agent-surface.md#idempotency). */
const KEY_LIFETIME_HOURS = 24;
/** One per process: a running row from another boot was left by a server that stopped mid-call. */
const PROCESS_BOOT_ID = NodeCrypto.randomUUID();

type Outcome = McpSchema.CallToolResult | McpSchema.InputRequired;
type Literal = { readonly _tag: string; readonly code?: string };
type KeyedEntry = AgentSurfaceEntry & { readonly path: string };
type Refusal = "in_progress" | "idempotency_mismatch" | "outcome_unknown" | "storage_failed";
interface Reserve {
  readonly environmentId: string;
  readonly principal: string;
  readonly path: string;
  readonly clientRequestId: string;
  readonly receiptId: string;
  readonly tool: string;
  readonly digest: string;
  readonly profileId: string | null;
  readonly ceiling: string | null;
  readonly host: string | null;
}
type Reservation =
  | { readonly kind: "reserved" }
  | {
      readonly kind: "replay";
      readonly result: McpSchema.CallToolResult;
      readonly failure?: Literal;
    }
  | { readonly kind: Refusal };

const keyedEntries: ReadonlyMap<string, KeyedEntry> = new Map(
  Object.values(agentSurfaceRegistry)
    .filter((entry) => isKeyedWrite(entry))
    .map((entry) => [entry.name, entry] as const),
);

const isCallToolResult = Schema.is(McpSchema.CallToolResult);
const ResultJson = Schema.fromJsonString(Schema.toCodecJson(McpSchema.CallToolResult));
const LiteralJson = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
);
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeResult = Schema.decodeEffect(ResultJson);
const encodeResult = Schema.encodeEffect(ResultJson);
const decodeLiteral = Schema.decodeEffect(LiteralJson);
const encodeLiteral = Schema.encodeEffect(LiteralJson);

/** Sorted object keys, array order kept, undefined dropped; null stays distinct from omitted. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, field]) => field !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, field]) => [key, canonical(field)]),
        )
      : value;

/** The digest of decoded arguments, so equivalent spellings of one request match. */
export const argumentsDigest = (params: unknown) =>
  encodeJson(canonical(params)).pipe(
    Effect.map((text) => NodeCrypto.createHash("sha256").update(text).digest("hex")),
  );

/** A thread acts as itself; an outside client as its session. In-process calls have no key. */
const principalOf = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.thread !== undefined
    ? `thread:${scope.thread.threadId}`
    : scope.client !== undefined
      ? `client:${scope.client.sessionId}`
      : undefined;

const toolNameOf = (path: string) =>
  (agentSurfaceRegistry as Readonly<Record<string, AgentSurfaceEntry>>)[path]?.name ?? path;

const reservationRefusal = (reason: Refusal, entry: KeyedEntry, clientRequestId: string) => {
  const reconcile = entry.reconcile ?? entry.path;
  const call = `${entry.name} with clientRequestId ${clientRequestId}`;
  switch (reason) {
    case "outcome_unknown":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          mayHaveStarted: true,
          reconcile,
          message: `${call} started, but its outcome was never recorded, so GOAT will not run it again. Read ${toolNameOf(reconcile)} to see whether it happened. Only if it did not, call again with a new clientRequestId.`,
        }),
      );
    case "storage_failed":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          reason,
          message: `GOAT could not record ${call}, so it did not run.`,
        }),
      );
    case "in_progress":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          message: `${call} is still running, so this call did not run. Call again with the same arguments for its result once it ends.`,
        }),
      );
    case "idempotency_mismatch":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          message: `clientRequestId ${clientRequestId} was already used for ${entry.name} with other arguments, so this call did not run. Use a new clientRequestId for a different request.`,
        }),
      );
  }
};

const makeStore = (sql: SqlClient.SqlClient, bootId: string) => {
  const reserve = Effect.fn("ToolAdmission.reserve")(function* (request: Reserve) {
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    // Only completed keys expire: an unsettled one must never run again.
    yield* sql`DELETE FROM mcp_request_reservations
      WHERE state = 'completed' AND expires_at <= ${createdAt}`;
    const inserted = yield* sql<{ readonly receipt_id: string }>`
      INSERT INTO mcp_request_reservations (environment_id, principal, path, client_request_id,
        receipt_id, tool_name, args_digest, profile_id, ceiling, host, state, boot_id,
        created_at, expires_at)
      VALUES (${request.environmentId}, ${request.principal}, ${request.path},
        ${request.clientRequestId}, ${request.receiptId}, ${request.tool}, ${request.digest},
        ${request.profileId}, ${request.ceiling}, ${request.host}, 'running', ${bootId},
        ${createdAt}, ${DateTime.formatIso(DateTime.add(now, { hours: KEY_LIFETIME_HOURS }))})
      ON CONFLICT DO NOTHING RETURNING receipt_id`;
    if (inserted.length === 1) return { kind: "reserved" } satisfies Reservation as Reservation;
    const [row] = yield* sql<{
      readonly args_digest: string;
      readonly state: "running" | "completed" | "unknown";
      readonly boot_id: string;
      readonly result_json: string | null;
      readonly failure_json: string | null;
    }>`SELECT args_digest, state, boot_id, result_json, failure_json FROM mcp_request_reservations
      WHERE environment_id = ${request.environmentId} AND principal = ${request.principal}
        AND path = ${request.path} AND client_request_id = ${request.clientRequestId}`;
    // A row released between the insert and this read belonged to a call that just ended.
    if (row === undefined) return { kind: "in_progress" } satisfies Reservation as Reservation;
    if (row.args_digest !== request.digest)
      return { kind: "idempotency_mismatch" } satisfies Reservation as Reservation;
    if (row.state === "running" && row.boot_id === bootId)
      return { kind: "in_progress" } satisfies Reservation as Reservation;
    if (row.state !== "completed" || row.result_json === null)
      return { kind: "outcome_unknown" } satisfies Reservation as Reservation;
    const result = yield* decodeResult(row.result_json);
    const failure = row.failure_json === null ? undefined : yield* decodeLiteral(row.failure_json);
    return {
      kind: "replay",
      result,
      ...(failure === undefined ? {} : { failure }),
    } satisfies Reservation as Reservation;
  });

  /** Fenced by receipt id: only the reservation that made the row settles it. */
  const settle = Effect.fn("ToolAdmission.settle")(function* (
    receiptId: string,
    settlement: "completed" | "released" | "unknown",
    result: McpSchema.CallToolResult | undefined,
    failure: Literal | undefined,
  ) {
    if (settlement === "released") {
      yield* sql`DELETE FROM mcp_request_reservations
        WHERE receipt_id = ${receiptId} AND state = 'running'`;
      return;
    }
    const resultJson = result === undefined ? null : yield* encodeResult(result);
    const failureJson = failure === undefined ? null : yield* encodeLiteral(failure);
    const envelope = result === undefined ? undefined : fromToolResult(result, { effect: "write" });
    const outcome = envelope?.status === "error" ? envelope.error.code : (envelope?.status ?? null);
    yield* sql`UPDATE mcp_request_reservations SET state = ${settlement},
      result_json = ${resultJson}, failure_json = ${failureJson}, outcome_code = ${outcome},
      completed_at = ${DateTime.formatIso(yield* DateTime.now)}
      WHERE receipt_id = ${receiptId} AND state = 'running'`;
  });
  return { reserve, settle };
};

/** A call outside a keyed reservation must not inherit an enclosing call's admission. */
const unkeyed = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.provideService(run, McpToolAccess.KeyedAdmission, { admit: () => Effect.void });

/**
 * The gate every registered tool call passes, direct or through goat_call: the goatclaw
 * capability, then, for a write the registry keys, its clientRequestId. The key is reserved
 * where the declaration admits the write, after every caller check, so a replay passes them
 * all again. Without a database a keyed call is refused before it runs, as goatclaw fails closed.
 */
export const make = Effect.fn("ToolAdmission.make")(function* (bootId: string = PROCESS_BOOT_ID) {
  const permissions = yield* Profiles.PermissionProfiles;
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  const store = Option.map(database, (sql) => makeStore(sql, bootId));

  /** Who reserved the key under which grant, for the receipt's audit columns. */
  const auditOf = (scope: McpInvocationContext.McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.succeed({ profileId: null, ceiling: scope.client?.access ?? null })
      : permissions.resolve(scope).pipe(
          Effect.map((view) => ({
            profileId: view.enabled ? view.profile.id : null,
            ceiling: view.runtimeMode,
          })),
          Effect.orElseSucceed(() => ({ profileId: null, ceiling: null })),
        );

  const keyed =
    /* The request's span already covers each call. */
    Effect.fnUntraced(function* <E, R>(
      entry: KeyedEntry,
      clientRequestId: string,
      args: Readonly<Record<string, unknown>>,
      handle: (payload: unknown) => Effect.Effect<Outcome, E, R>,
    ) {
      const scope = Option.getOrUndefined(
        yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
      );
      const principal = scope === undefined ? undefined : principalOf(scope);
      if (scope === undefined || principal === undefined) return yield* unkeyed(handle(args));
      const decided = yield* Deferred.make<McpSchema.CallToolResult>();
      const held = yield* Ref.make<string | undefined>(undefined);
      const admittedOnce = yield* Ref.make(false);
      const failure = yield* Ref.make<Literal | undefined>(undefined);
      const outer = yield* Effect.serviceOption(McpToolAccess.CallFailureCapture);
      const forward = (error: unknown) =>
        Option.isSome(outer) ? outer.value.record(error) : Effect.void;
      // Ends the call with \`result\` and parks the handler, which the race then interrupts.
      const decide = (result: McpSchema.CallToolResult) =>
        Effect.andThen(Deferred.succeed(decided, result), Effect.never);

      const reservationFor = Effect.fnUntraced(function* (params: unknown) {
        if (Option.isNone(store)) return { kind: "storage_failed" } as const;
        const digest = yield* argumentsDigest(params);
        const audit = yield* auditOf(scope);
        const host = (params as { readonly host?: unknown } | null)?.host;
        const receiptId = NodeCrypto.randomUUID();
        const reservation = yield* store.value.reserve({
          environmentId: scope.environmentId,
          principal,
          path: entry.path,
          clientRequestId,
          receiptId,
          tool: entry.name,
          digest,
          ...audit,
          host: typeof host === "string" ? host : null,
        });
        if (reservation.kind === "reserved") yield* Ref.set(held, receiptId);
        return reservation;
      });

      const admit = (params: unknown): Effect.Effect<void> =>
        Effect.flatMap(Ref.getAndSet(admittedOnce, true), (again) =>
          again
            ? Effect.void
            : // A reservation is held from the insert on, so an interrupt cannot strand it unrecorded.
              Effect.uninterruptibleMask((restore) =>
                reservationFor(params).pipe(
                  Effect.catchCause((cause) =>
                    Effect.as(
                      Effect.logError("clientRequestId reservation failed", {
                        tool: entry.name,
                        cause,
                      }),
                      { kind: "storage_failed" } as const,
                    ),
                  ),
                  Effect.flatMap((reservation) => {
                    switch (reservation.kind) {
                      case "reserved":
                        return Effect.void;
                      case "replay":
                        // goat_call reclassifies the replayed failure as it did the first call's.
                        return restore(
                          Effect.andThen(
                            reservation.failure === undefined
                              ? Effect.void
                              : forward(reservation.failure),
                            decide(reservation.result),
                          ),
                        );
                      default:
                        return restore(
                          decide(reservationRefusal(reservation.kind, entry, clientRequestId)),
                        );
                    }
                  }),
                ),
              ),
        );

      const settle = (
        settlement: "completed" | "released" | "unknown",
        result?: McpSchema.CallToolResult,
      ) =>
        Effect.flatMap(Ref.get(held), (receiptId) =>
          receiptId === undefined || Option.isNone(store)
            ? Effect.void
            : Effect.flatMap(Ref.get(failure), (literal) =>
                store.value.settle(receiptId, settlement, result, literal),
              ).pipe(
                // The row stays running, so a retry here waits and a later process reads unknown.
                Effect.catchCause((cause) =>
                  Effect.logError("clientRequestId outcome was not recorded", {
                    tool: entry.name,
                    cause,
                  }),
                ),
              ),
        );

      return yield* Effect.raceFirst(
        handle(args).pipe(
          Effect.provideService(McpToolAccess.KeyedAdmission, { admit }),
          Effect.provideService(McpToolAccess.CallFailureCapture, {
            record: (error) =>
              Effect.andThen(Ref.set(failure, declaredFailureLiteral(error)), forward(error)),
          }),
        ),
        Deferred.await(decided),
      ).pipe(
        Effect.onExit((exit) => {
          // Interrupted or failed after it was admitted: the write may have happened.
          if (exit._tag === "Failure") return settle("unknown");
          const result = exit.value;
          if (!isCallToolResult(result)) return settle("released");
          return Effect.flatMap(Ref.get(failure), (literal) =>
            settle(settlementOf(fromToolResult(result, { effect: entry.effect }), literal), result),
          );
        }),
      );
    });

  const admitted = <E, R>(
    tool: string,
    payload: unknown,
    handle: (payload: unknown) => Effect.Effect<Outcome, E, R>,
  ) => {
    const entry = keyedEntries.get(tool);
    if (entry === undefined || typeof payload !== "object" || payload === null)
      return unkeyed(handle(payload));
    // Handlers never see the key, so a routed call never forwards it to an older remote.
    const { clientRequestId, ...args } = payload as Readonly<Record<string, unknown>>;
    return typeof clientRequestId === "string"
      ? keyed(entry, clientRequestId, args, handle)
      : unkeyed(handle(args));
  };

  // Arguments never decode for a caller whose goatclaw profile refuses the tool.
  return <E, R>(
    tool: string,
    effect: AgentSurfaceEntry["effect"],
    payload: unknown,
    handle: (payload: unknown) => Effect.Effect<Outcome, E, R>,
  ) =>
    McpToolAccess.requireDeclaredCapability(permissions, tool, effect, payload).pipe(
      Effect.matchEffect({
        onFailure: (refused) => Effect.succeed<Outcome>(refusalResult(refused)),
        onSuccess: () => admitted(tool, payload, handle),
      }),
    );
});
