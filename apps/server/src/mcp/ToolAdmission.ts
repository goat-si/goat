// @effect-diagnostics-next-line nodeBuiltinImport:off -- argument digests and receipt ids need node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  AuthEnvironmentScope,
  GOATCLAW_ROLE_PROFILES,
  GoatclawRole,
  OrchestratorMcpFailure,
  PermissionProfile,
  ProviderInteractionMode,
  RuntimeMode,
} from "@goat/contracts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import type { CallerLimits } from "./threadAccess.ts";
import { KeyedClientRequestId } from "./toolkits/keyedParameters.ts";
import { refusalResult } from "./toolRefusals.ts";

/** Completed keys live at least this long (docs/internals/agent-surface.md#idempotency). */
const KEY_LIFETIME_HOURS = 24;
/** One per process: a running row from another boot was left by a server that stopped mid-call. */
const PROCESS_BOOT_ID = NodeCrypto.randomUUID();
/**
 * Reservations whose call ended but whose outcome could not be written. Their rows still say
 * running under this boot, which would otherwise read as in_progress until the next restart.
 * Process-wide like the boot id; it only grows when the database refuses a write.
 */
const ABANDONED_RECEIPTS = new Set<string>();

type Outcome = McpSchema.CallToolResult | McpSchema.InputRequired;
type Literal = { readonly _tag: string; readonly code?: string };
type KeyedEntry = AgentSurfaceEntry & { readonly path: string };
type Refusal =
  | "in_progress"
  | "idempotency_mismatch"
  | "outcome_unknown"
  | "storage_failed"
  | "grant_lost";
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
  readonly grant: Grant;
}
type Reservation =
  | { readonly kind: "reserved" }
  | {
      readonly kind: "replay";
      readonly result: McpSchema.CallToolResult;
      readonly failure?: Literal;
      readonly grant: Grant;
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
const decodeKey = Schema.decodeUnknownEffect(KeyedClientRequestId);
const decodeForwarded = Schema.decodeUnknownOption(PermissionProfile);
const decodeRole = Schema.decodeUnknownOption(GoatclawRole);

/**
 * What the caller held when it reserved the key. A replay needs at least as much, so a grant
 * narrowed where a handler or service checks it, not only at the capability gate, is refused.
 * goatclaw null means no profile applied; scopes null means a thread credential.
 */
const ProfileGrant = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  runtimeMode: RuntimeMode,
  /** null allows every host. */
  hosts: Schema.NullOr(Schema.Array(Schema.String)),
});
type ProfileGrant = typeof ProfileGrant.Type;
const Grant = Schema.Struct({
  /** The caller's own modes, which an omitted mode inherits. */
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** The caller's goatclaw profile; null while goatclaw is off. */
  goatclaw: Schema.NullOr(ProfileGrant),
  /** For a role launch, what the child gets: the role's profile within the caller's. */
  role: Schema.NullOr(ProfileGrant),
  scopes: Schema.NullOr(Schema.Array(AuthEnvironmentScope)),
  readOnly: Schema.Boolean,
});
type Grant = typeof Grant.Type;
const GrantJson = Schema.fromJsonString(Grant);
const encodeGrant = Schema.encodeEffect(GrantJson);
const decodeGrant = Schema.decodeEffect(GrantJson);

const rank = (mode: RuntimeMode) => RuntimeMode.literals.indexOf(mode);
// plan cannot do what default does, so default is the broader interaction mode.
const interactionRank = (mode: ProviderInteractionMode) => (mode === "default" ? 1 : 0);
const holdsAll = (held: ReadonlyArray<string> | null, needed: ReadonlyArray<string> | null) =>
  (needed ?? []).every((item) => (held ?? []).includes(item));
const allowsHosts = (held: ReadonlyArray<string> | null, needed: ReadonlyArray<string> | null) =>
  held === null || (needed !== null && needed.every((host) => held.includes(host)));

/** Whether `current` still holds everything `recorded` did. */
const coversProfile = (current: ProfileGrant | null, recorded: ProfileGrant | null) =>
  recorded === null
    ? current === null
    : current !== null &&
      holdsAll(current.capabilities, recorded.capabilities) &&
      rank(current.runtimeMode) >= rank(recorded.runtimeMode) &&
      allowsHosts(current.hosts, recorded.hosts);

const coversGrant = (current: Grant, recorded: Grant) =>
  (recorded.readOnly || !current.readOnly) &&
  rank(current.runtimeMode) >= rank(recorded.runtimeMode) &&
  interactionRank(current.interactionMode) >= interactionRank(recorded.interactionMode) &&
  holdsAll(current.scopes, recorded.scopes) &&
  // goatclaw off applies no profile, so it covers any profile recorded while it was on; turning
  // it on narrows a key recorded while it was off.
  (current.goatclaw === null || coversProfile(current.goatclaw, recorded.goatclaw)) &&
  // A role launch needs goatclaw, so its grant must still be held as recorded.
  (recorded.role === null || coversProfile(current.role, recorded.role));

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

const hostOf = (params: unknown) => {
  const host = (params as { readonly host?: unknown } | null)?.host;
  return typeof host === "string" ? host : undefined;
};

const toolNameOf = (path: string) =>
  (agentSurfaceRegistry as Readonly<Record<string, AgentSurfaceEntry>>)[path]?.name ?? path;

const reservationRefusal = (
  reason: Refusal,
  entry: KeyedEntry,
  clientRequestId: string,
  host: string | undefined,
) => {
  const reconcile = entry.reconcile ?? entry.path;
  // A routed write happened on that host, so only the same read there can settle it.
  const where = host === undefined ? "" : ` with host ${host}`;
  const call = `${entry.name} with clientRequestId ${clientRequestId}`;
  switch (reason) {
    case "grant_lost":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `This caller no longer holds the grant it had when it first sent ${call}, so GOAT does not return that call's result.`,
        }),
      );
    case "outcome_unknown":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          mayHaveStarted: true,
          reconcile,
          message: `${call} started, but its outcome was never recorded, so GOAT will not run it again. Read ${toolNameOf(reconcile)}${where} to see whether it happened. Only if it did not, call again with a new clientRequestId.`,
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
        receipt_id, tool_name, args_digest, profile_id, ceiling, host, grant_json, state,
        boot_id, created_at, expires_at)
      VALUES (${request.environmentId}, ${request.principal}, ${request.path},
        ${request.clientRequestId}, ${request.receiptId}, ${request.tool}, ${request.digest},
        ${request.profileId}, ${request.ceiling}, ${request.host},
        ${yield* encodeGrant(request.grant)}, 'running', ${bootId}, ${createdAt},
        ${DateTime.formatIso(DateTime.add(now, { hours: KEY_LIFETIME_HOURS }))})
      ON CONFLICT DO NOTHING RETURNING receipt_id`;
    if (inserted.length === 1) return { kind: "reserved" } satisfies Reservation as Reservation;
    const [row] = yield* sql<{
      readonly args_digest: string;
      readonly state: "running" | "completed" | "unknown";
      readonly boot_id: string;
      readonly result_json: string | null;
      readonly failure_json: string | null;
      readonly grant_json: string;
      readonly receipt_id: string;
    }>`SELECT args_digest, state, boot_id, result_json, failure_json, grant_json, receipt_id
      FROM mcp_request_reservations
      WHERE environment_id = ${request.environmentId} AND principal = ${request.principal}
        AND path = ${request.path} AND client_request_id = ${request.clientRequestId}`;
    // A row released between the insert and this read belonged to a call that just ended.
    if (row === undefined) return { kind: "in_progress" } satisfies Reservation as Reservation;
    if (row.args_digest !== request.digest)
      return { kind: "idempotency_mismatch" } satisfies Reservation as Reservation;
    if (
      row.state === "running" &&
      row.boot_id === bootId &&
      !ABANDONED_RECEIPTS.has(row.receipt_id)
    )
      return { kind: "in_progress" } satisfies Reservation as Reservation;
    if (row.state !== "completed" || row.result_json === null)
      return { kind: "outcome_unknown" } satisfies Reservation as Reservation;
    const result = yield* decodeResult(row.result_json);
    const failure = row.failure_json === null ? undefined : yield* decodeLiteral(row.failure_json);
    return {
      kind: "replay",
      result,
      grant: yield* decodeGrant(row.grant_json),
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
  /** The outcome could not be recorded: from now on the key reads unknown, in this process too. */
  const abandon = (receiptId: string) =>
    Effect.sync(() => ABANDONED_RECEIPTS.add(receiptId)).pipe(
      Effect.andThen(
        sql`UPDATE mcp_request_reservations SET state = 'unknown'
          WHERE receipt_id = ${receiptId} AND state = 'running'`,
      ),
      Effect.ignoreCause,
    );
  return { reserve, settle, abandon };
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
  // goatclaw itself reads these settings; a role launch's profile cannot resolve without them.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  const store = Option.map(database, (sql) => makeStore(sql, bootId));

  /**
   * The caller's grant now, and the audit columns it fills, resolved the way a launch resolves
   * it: an outside dispatch's forwarded ceiling narrows the destination's profile, and a role
   * launch holds only what the role's profile and the caller's share. A profile that cannot
   * resolve refuses the call, as the launch itself would.
   */
  const grantOf = Effect.fnUntraced(function* (
    scope: McpInvocationContext.McpInvocationScope,
    params: unknown,
    limits: CallerLimits,
  ) {
    const readOnly = scope.readOnly === true || scope.client?.access === "read-only";
    const scopes = scope.grantedScopes ?? null;
    const fields = (typeof params === "object" && params !== null ? params : {}) as Readonly<
      Record<string, unknown>
    >;
    const forwarded =
      scope.thread === undefined
        ? Option.getOrUndefined(decodeForwarded(fields.permissionProfileCeiling))
        : undefined;
    const view = yield* permissions.resolve(scope, undefined, forwarded);
    const role = Option.getOrUndefined(decodeRole(fields.goatclawRole));
    if (role !== undefined && view.enabled && Option.isNone(settings))
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "GOAT could not read the goatclaw role profiles, so this launch did not run.",
      });
    const named =
      role === undefined || !view.enabled || Option.isNone(settings)
        ? undefined
        : (yield* settings.value.getSettings).goatclaw.profiles[GOATCLAW_ROLE_PROFILES[role]];
    // What claim grants a role launch: the role's profile within the caller's.
    const roleProfile =
      role === undefined || !view.enabled
        ? undefined
        : named === undefined
          ? { ...view.profile, capabilities: [], hosts: [] }
          : Profiles.intersectProfiles(named, view.profile);
    return {
      profileId: view.enabled ? view.profile.id : null,
      ceiling: view.runtimeMode,
      grant: {
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        goatclaw: view.enabled
          ? {
              capabilities: view.profile.capabilities,
              runtimeMode: view.runtimeMode,
              hosts: view.profile.hosts ?? null,
            }
          : null,
        role:
          roleProfile === undefined
            ? null
            : {
                capabilities: roleProfile.capabilities,
                runtimeMode:
                  rank(roleProfile.runtimeModeCeiling) < rank(view.runtimeMode)
                    ? roleProfile.runtimeModeCeiling
                    : view.runtimeMode,
                hosts: roleProfile.hosts ?? null,
              },
        scopes,
        readOnly,
      } satisfies Grant,
    };
  });

  /** A replay is answered only while the caller holds the grant it reserved the key with. */
  const stillGranted = (
    scope: McpInvocationContext.McpInvocationScope,
    current: Grant,
    recorded: Grant,
  ) =>
    !coversGrant(current, recorded)
      ? Effect.succeed(false)
      : scope.reauthorize === undefined || recorded.scopes === null
        ? Effect.succeed(true)
        : scope.reauthorize(recorded.scopes).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
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
      // Ends the call with `result` and parks the handler, which the race then interrupts.
      const decide = (result: McpSchema.CallToolResult) =>
        Effect.andThen(Deferred.succeed(decided, result), Effect.never);

      const reservationFor = Effect.fnUntraced(function* (
        params: unknown,
        limits: CallerLimits | undefined,
      ) {
        if (Option.isNone(store)) return { kind: "storage_failed" } as const;
        // Every write declaration resolves the caller's modes first; without them, fail closed.
        if (limits === undefined) return { kind: "storage_failed" } as const;
        const digest = yield* argumentsDigest(params);
        const granted = yield* grantOf(scope, params, limits).pipe(
          Effect.catchTags({ OrchestratorMcpFailure: (failure) => Effect.succeed({ failure }) }),
        );
        if ("failure" in granted) return { kind: "refused", failure: granted.failure } as const;
        const { grant, ...audit } = granted;
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
          grant,
          host: hostOf(params) ?? null,
        });
        if (reservation.kind === "reserved") yield* Ref.set(held, receiptId);
        if (
          reservation.kind === "replay" &&
          !(yield* stillGranted(scope, grant, reservation.grant))
        )
          return { kind: "grant_lost" } as const;
        return reservation;
      });

      const admit = (params: unknown, limits: CallerLimits | undefined): Effect.Effect<void> =>
        Effect.flatMap(Ref.getAndSet(admittedOnce, true), (again) =>
          again
            ? Effect.void
            : // A reservation is held from the insert on, so an interrupt cannot strand it unrecorded.
              Effect.uninterruptibleMask((restore) =>
                reservationFor(params, limits).pipe(
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
                      case "refused":
                        return restore(decide(refusalResult(reservation.failure)));
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
                          decide(
                            reservationRefusal(
                              reservation.kind,
                              entry,
                              clientRequestId,
                              hostOf(params),
                            ),
                          ),
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
                Effect.catchCause((cause) =>
                  Effect.logError("clientRequestId outcome was not recorded", {
                    tool: entry.name,
                    cause,
                  }).pipe(Effect.andThen(store.value.abandon(receiptId))),
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
    // The advertised JSON codec offers null for an omitted optional key.
    if (clientRequestId === undefined || clientRequestId === null) return unkeyed(handle(args));
    return decodeKey(clientRequestId).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed<Outcome>(
            refusalResult(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `clientRequestId must be a non-blank string of at most 256 characters, so ${tool} did not run.`,
              }),
            ),
          ),
        onSuccess: (key) => keyed(entry, key, args, handle),
      }),
    );
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
