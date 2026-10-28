// @effect-diagnostics-next-line nodeBuiltinImport:off -- run ids and element digests need node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  type AgentSurfaceResult,
  fromToolResult,
  settlementOf,
} from "@goat/contracts/agentSurface/envelope";
import {
  EVAL_LIMITS,
  type EvalInput,
  type EvalOperation,
  type EvalResult,
  type EvalStepRef,
} from "@goat/contracts/agentSurface/eval";
import { isKeyedWrite, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import type { HandoffReader } from "../../operations/handoffReads.ts";
import type { HostConditions } from "../../toolAvailability.ts";
import {
  argumentsDigest,
  derivedStepRequestId,
  type EvalAdmission,
  KEY_LIFETIME_HOURS,
  principalOf,
} from "../../ToolAdmission.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { type EvalJournal, makeEvalJournal } from "./evalJournal.ts";
import { makeEvalPlan } from "./evalPlan.ts";
import {
  analyzeProgram,
  type CallSite,
  type Expr,
  explicitKey,
  type Json,
  type Node,
  type Program,
  ProgramRefusal,
  readProgram,
} from "./evalParser.ts";

type Envelope = AgentSurfaceResult;
type ErrorEnvelope = Extract<Envelope, { readonly status: "error" }>;
type Halting = ErrorEnvelope | Extract<Envelope, { readonly status: "needs_human" }>;

/**
 * Stops the program at a step. Only a catchable halt is a value inside try: needs_human,
 * unknown_outcome and the run's own limits always stop it.
 */
class EvalHalt extends Data.TaggedError("EvalHalt")<{
  readonly result: Halting;
  readonly at: string;
  readonly catchable: boolean;
}> {}

export interface EvalRunnerOptions<R> {
  /** Runs one call exactly as goat_call does, so every target keeps its own checks (D6). */
  readonly invoke: (
    path: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Envelope, never, R>;
  readonly dispatch: ToolDispatch["Service"];
  readonly permissions: Profiles.PermissionProfiles["Service"];
  readonly admission: EvalAdmission;
  readonly readHandoff: HandoffReader;
  readonly hostConditions?: Effect.Effect<HostConditions>;
}

const failure = (
  code: ErrorEnvelope["error"]["code"],
  reason: string,
  message: string,
  details?: unknown,
): ErrorEnvelope => ({
  status: "error",
  error: {
    code,
    reason,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  },
});
const halt = (result: Halting, at: string, catchable = false) =>
  new EvalHalt({ result, at, catchable });
const refused = (code: ErrorEnvelope["error"]["code"], reason: string, message: string) =>
  failure(code, reason, message) satisfies EvalResult;

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(UnknownJson);
const fromJson = Schema.decodeSync(UnknownJson);

const digest12 = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(toJson(value ?? null))
    .digest("hex")
    .slice(0, 12);
const bytesOf = (value: unknown) => Buffer.byteLength(toJson(value ?? null), "utf8");
const isRecord = (value: unknown): value is Readonly<Record<string, Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const truthy = (value: Json) => value !== false && value !== null;
const sameJson = (a: Json, b: Json): boolean => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index] as Json));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && sameJson(a[key] as Json, b[key] as Json))
    );
  }
  return a === b;
};
const keyOf = (value: Json) =>
  typeof value === "string" || (typeof value === "number" && Number.isInteger(value))
    ? value
    : undefined;

const unknownOutcome = (path: string, reconcile: string | undefined, from?: ErrorEnvelope) =>
  failure(
    "unknown_outcome",
    from?.error.reason ?? "outcome_unknown",
    `${path} may have run, so this run will not call it again.${reconcile === undefined ? "" : ` Read ${reconcile} to see whether it happened.`} Put the remaining work in a new program.`,
    reconcile === undefined ? undefined : { reconcile },
  );

/**
 * goat_eval's runner (docs/internals/agent-surface.md#composition-goat_eval). The mount passes
 * goat_call's own function as invoke, so a program adds no authority: every call runs the
 * target's checks, and its journal answers a retry only for a caller that still holds each
 * step's grant.
 */
export const makeEvalRunner = <R>(options: EvalRunnerOptions<R>) => {
  const { invoke, permissions, admission, readHandoff } = options;
  const plan = makeEvalPlan(
    options.dispatch,
    permissions,
    options.hostConditions ?? Effect.succeed({}),
  );

  const run = Effect.fn("AgentSurface.eval")(function* (input: EvalInput) {
    const scope = yield* McpInvocationContext;
    const principal = principalOf(scope);
    if (principal === undefined)
      return refused(
        "unauthenticated",
        "eval_caller_required",
        "goat_eval runs for a thread or a signed-in client.",
      );
    const parsed = attempt(() =>
      input.program === undefined ? undefined : readProgram(input.program),
    );
    if (parsed !== undefined && "status" in parsed) return parsed;
    if (input.dryRun === true) {
      if (parsed === undefined)
        return refused("invalid_request", "eval_program_required", "dryRun needs a program.");
      const analyzed = attempt(() => analyzeProgram(parsed, Object.keys(input.bindings ?? {})));
      if ("status" in analyzed) return analyzed;
      return yield* plan(analyzed);
    }
    const database = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(database))
      return refused("internal", "storage_failed", "goat_eval needs this server's database.");
    const journal = makeEvalJournal(database.value, admission.bootId);
    const opened = yield* open(journal, input, parsed, principal).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("goat_eval could not open its run", { cause }).pipe(
          Effect.as(
            refused(
              "internal",
              "storage_failed",
              "GOAT could not record this run, so it did not run.",
            ),
          ),
        ),
      ),
    );
    if ("status" in opened) return opened;
    return yield* execute(journal, opened);
  });

  interface Opened {
    readonly evalRunId: string;
    readonly claimId: string;
    readonly program: Program;
    readonly bindings: Readonly<Record<string, Json>>;
  }

  const open = Effect.fnUntraced(function* (
    journal: EvalJournal,
    input: EvalInput,
    parsed: Node | undefined,
    principal: string,
  ) {
    const scope = yield* McpInvocationContext;
    const claimId = NodeCrypto.randomUUID();
    const stored =
      input.resume ??
      (input.clientRequestId === undefined
        ? undefined
        : runIdFor(scope.environmentId, principal, input.clientRequestId));
    const existing =
      stored === undefined
        ? undefined
        : yield* journal.findRun(stored, scope.environmentId, principal);
    if (input.resume !== undefined && existing === undefined)
      return refused(
        "not_found",
        "eval_run_not_found",
        `No run ${input.resume} of yours exists here; it may have expired.`,
      );
    const node =
      parsed ?? (existing === undefined ? undefined : (fromJson(existing.program_json) as Node));
    if (node === undefined)
      return refused(
        "invalid_request",
        "eval_program_required",
        "Pass a program, or resume a run.",
      );
    const bindings = (input.bindings ??
      (input.program === undefined && existing !== undefined
        ? fromJson(existing.bindings_json)
        : {})) as Readonly<Record<string, Json>>;
    const analyzed = attempt(() => analyzeProgram(node, Object.keys(bindings)));
    if ("status" in analyzed) return analyzed;
    const digest = yield* argumentsDigest({ program: node, bindings });
    if (existing !== undefined) {
      if (existing.program_digest !== digest)
        return input.resume !== undefined
          ? refused(
              "conflict",
              "eval_program_changed",
              `Run ${existing.eval_run_id} ran another program or bindings. Resume it with the same program, or omit program.`,
            )
          : refused(
              "conflict",
              "idempotency_mismatch",
              `clientRequestId ${input.clientRequestId} already named another program. Use a new clientRequestId for a different program.`,
            );
      if (!(yield* journal.claimRun(existing, claimId)))
        return refused(
          "conflict",
          "in_progress",
          `Run ${existing.eval_run_id} is still running. Call again for its result once it ends.`,
        );
      return {
        evalRunId: existing.eval_run_id,
        claimId,
        program: analyzed,
        bindings,
      } satisfies Opened;
    }
    const evalRunId = stored ?? `evr_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const created = yield* journal.createRun({
      evalRunId,
      environmentId: scope.environmentId,
      principal,
      clientRequestId: input.clientRequestId ?? null,
      programDigest: digest,
      programJson: toJson(node),
      bindingsJson: toJson(bindings),
      claimId,
    });
    if (!created)
      return refused(
        "conflict",
        "in_progress",
        `Run ${evalRunId} is still running. Call again for its result once it ends.`,
      );
    return { evalRunId, claimId, program: analyzed, bindings } satisfies Opened;
  });

  const execute = Effect.fnUntraced(function* (journal: EvalJournal, opened: Opened) {
    const state = {
      calls: 0,
      bytes: 0,
      live: 0,
      restored: 0,
      inflightWrite: undefined as string | undefined,
      completed: [] as Array<EvalStepRef>,
      operations: [] as Array<EvalOperation>,
    };
    const { evalRunId, claimId } = opened;
    const stored = <A, E, R2>(effect: Effect.Effect<A, E, R2>, at: string) =>
      effect.pipe(
        Effect.tapError((error) => Effect.logError("goat_eval journal write failed", { error })),
        Effect.mapError(() =>
          halt(
            failure(
              "internal",
              "storage_failed",
              "GOAT could not record this step, so the run stopped.",
            ),
            at,
          ),
        ),
      );
    const account = (value: unknown, at: string) => {
      state.bytes += bytesOf(value);
      return state.bytes > EVAL_LIMITS.resultBytes
        ? Effect.fail(
            halt(
              failure(
                "resource_exhausted",
                "eval_result_limit",
                `Step results passed ${EVAL_LIMITS.resultBytes} bytes. Pick fewer fields or split the program.`,
              ),
              at,
            ),
          )
        : Effect.void;
    };

    /** The caller must still hold the grant a recorded step ran under (D3). */
    const authorize = Effect.fnUntraced(function* (
      site: CallSite["entry"],
      args: Readonly<Record<string, unknown>>,
      grantJson: string,
      at: string,
    ) {
      const lost = () =>
        halt(
          failure(
            "permission_denied",
            "grant_lost",
            `This caller no longer holds the grant ${site.path} ran under, so GOAT does not return its recorded result.`,
          ),
          at,
        );
      const covered = yield* admission
        .covers(args, grantJson)
        .pipe(Effect.orElseSucceed(() => false));
      if (!covered) return yield* lost();
      yield* McpToolAccess.requireDeclaredCapability(
        permissions,
        site.name,
        site.effect,
        args,
      ).pipe(Effect.mapError(lost));
    });

    const step = Effect.fnUntraced(function* (
      expr: Extract<Expr, { readonly t: "call" }>,
      args: Readonly<Record<string, unknown>>,
      frames: string,
      caught: boolean,
    ) {
      const { entry } = expr;
      const at = `${expr.site}${frames}`;
      if ("clientRequestId" in args) {
        const refusal = explicitKey(entry.path);
        return yield* halt(failure(refusal.code, refusal.reason, refusal.message), at);
      }
      state.calls += 1;
      if (state.calls > EVAL_LIMITS.calls)
        return yield* halt(
          failure(
            "resource_exhausted",
            "eval_call_limit",
            `The run reached ${EVAL_LIMITS.calls} calls. Split the work into several programs.`,
          ),
          at,
        );
      const digest = yield* stored(argumentsDigest(args), at);
      const requestId = isKeyedWrite(entry)
        ? derivedStepRequestId(evalRunId, at, entry.path, digest)
        : null;
      const sent = requestId === null ? args : { ...args, clientRequestId: requestId };
      const reconcile = "reconcile" in entry ? entry.reconcile : undefined;
      const record = yield* stored(journal.readStep(evalRunId, at), at);
      let envelope: Envelope | undefined;
      let restored = false;
      if (record !== undefined) {
        if (record.path !== entry.path || record.args_digest !== digest)
          return yield* halt(
            failure(
              "conflict",
              "eval_step_changed",
              `Step ${at} ran ${record.path} with other arguments before, so this run cannot continue. Start a new program.`,
            ),
            at,
          );
        if (record.state === "completed" && record.result_json !== null) {
          yield* authorize(entry, args, record.grant_json, at);
          envelope = fromJson(record.result_json) as Envelope;
          restored = true;
        } else if (entry.effect !== "read") {
          const settledUnknown = (from?: ErrorEnvelope) =>
            stored(journal.settleStep(evalRunId, at, "unknown", null), at).pipe(
              Effect.andThen(Effect.fail(halt(unknownOutcome(entry.path, reconcile, from), at))),
            );
          if (requestId === null) return yield* settledUnknown();
          const outcome = yield* stored(admission.keyedOutcome(entry.path, requestId, args), at);
          const created = DateTime.makeUnsafe(record.created_at);
          const withinKeyLife = DateTime.isLessThan(
            yield* DateTime.now,
            DateTime.add(created, { hours: KEY_LIFETIME_HOURS }),
          );
          switch (outcome.kind) {
            case "replay":
              envelope = fromToolResult(outcome.result, {
                effect: entry.effect,
                deduplicated: true,
                pathOf: (name) => resolveAgentSurfaceEntry(name)?.path,
              });
              yield* stored(journal.settleStep(evalRunId, at, "completed", toJson(envelope)), at);
              restored = true;
              break;
            case "grant_lost":
              return yield* halt(
                failure(
                  "permission_denied",
                  "grant_lost",
                  `This caller no longer holds the grant ${entry.path} ran under, so GOAT does not return its recorded result.`,
                ),
                at,
              );
            case "in_progress":
              return yield* halt(
                failure(
                  "conflict",
                  "in_progress",
                  `${entry.path} is still running. Resume once it ends.`,
                ),
                at,
              );
            case "absent":
              // The key was first used by this step, so within its life no reservation means nothing ran.
              if (!withinKeyLife) return yield* settledUnknown();
              break;
            case "unknown":
              return yield* settledUnknown();
          }
        }
      }
      if (envelope === undefined) {
        const grantJson = yield* admission
          .grantFor(args)
          .pipe(
            Effect.mapError((error) =>
              halt(
                failure(
                  "permission_denied",
                  "grant_unresolved",
                  error instanceof Error
                    ? error.message
                    : `GOAT could not resolve this caller's grant for ${entry.path}.`,
                ),
                at,
              ),
            ),
          );
        yield* stored(
          journal.reserveStep({
            evalRunId,
            coord: at,
            path: entry.path,
            effect: entry.effect,
            argsDigest: digest,
            requestId,
            grantJson,
            claimId,
          }),
          at,
        );
        if (entry.effect !== "read") state.inflightWrite = at;
        const answered = yield* invoke(entry.path, sent).pipe(
          Effect.onInterrupt(() =>
            journal
              .settleStep(evalRunId, at, entry.effect === "read" ? "released" : "unknown", null)
              .pipe(Effect.ignoreCause),
          ),
        );
        state.inflightWrite = undefined;
        state.live += 1;
        let settlement: "completed" | "released" | "unknown" =
          answered.status === "error" ? settlementOf(answered) : "completed";
        // A read changes nothing, so an unsettled one is simply asked again.
        if (entry.effect === "read" && settlement === "unknown") settlement = "released";
        if (answered.status === "error" && settlement === "unknown") {
          yield* stored(journal.settleStep(evalRunId, at, "unknown", null), at);
          return yield* halt(unknownOutcome(entry.path, reconcile, answered), at);
        }
        // What control flow consumes is kept, so a resumed run takes the same branch.
        if (caught) settlement = "completed";
        yield* stored(
          journal.settleStep(
            evalRunId,
            at,
            settlement,
            settlement === "completed" ? toJson(answered) : null,
          ),
          at,
        );
        envelope = answered;
        if (settlement === "completed") state.completed.push({ step: at, path: entry.path });
      } else {
        state.restored += 1;
        state.completed.push({ step: at, path: entry.path });
      }
      yield* account(envelope, at);
      if (envelope.status === "ok") {
        const operation = envelope.meta?.operation;
        if (operation !== undefined)
          state.operations.push({ step: at, path: entry.path, operation });
        return (envelope.value ?? null) as Json;
      }
      if (envelope.status === "needs_human") {
        if (!restored) return yield* halt(envelope, at);
        // The person's action finishes this step through the handoff; it never runs again.
        const read = yield* readHandoff(envelope.handoff.handoffId);
        if (read.status === "needs_human") return yield* halt(read, at);
        return yield* halt(
          failure(
            "failed_precondition",
            "eval_handoff_settled",
            `The handoff for ${entry.path} is settled; this run does not call it again. Put the remaining work in a new program.`,
            { handoff: read },
          ),
          at,
        );
      }
      return yield* halt(envelope, at, envelope.error.code !== "unknown_outcome");
    });

    const evaluate = (
      expr: Expr,
      env: ReadonlyMap<string, Json>,
      frames: string,
      caught: boolean,
    ): Effect.Effect<
      Json,
      EvalHalt,
      R | McpInvocationContext | ThreadManagement.ThreadManagementService
    > => {
      const go = (inner: Expr, scope = env, innerFrames = frames, innerCaught = caught) =>
        evaluate(inner, scope, innerFrames, innerCaught);
      const all = (items: ReadonlyArray<Expr>) => Effect.forEach(items, (item) => go(item));
      const typeError = (message: string, at: string) =>
        Effect.fail(halt(failure("invalid_request", "eval_type", message), at));
      switch (expr.t) {
        case "lit":
          return Effect.succeed(expr.v);
        case "var":
          return Effect.succeed(env.get(expr.name) ?? null);
        case "vec":
          return all(expr.items);
        case "seq":
          return all(expr.items);
        case "obj":
          return Effect.map(
            Effect.forEach(expr.entries, ([key, value]) =>
              Effect.map(go(value), (v) => [key, v] as const),
            ),
            (entries) => Object.fromEntries(entries) as Json,
          );
        case "call":
          return Effect.flatMap(go(expr.args), (args) =>
            isRecord(args)
              ? step(expr, args, frames, caught)
              : typeError(`${expr.entry.path} takes a map of arguments.`, `${expr.site}${frames}`),
          );
        case "let":
          return Effect.gen(function* () {
            const scope = new Map(env);
            for (const [name, value] of expr.binds) scope.set(name, yield* go(value, scope));
            let last: Json = null;
            for (const item of expr.body) last = yield* go(item, scope);
            return last;
          });
        case "get":
          return Effect.gen(function* () {
            let current = yield* go(expr.target);
            for (const keyExpr of expr.keys) {
              const key = keyOf(yield* go(keyExpr));
              current =
                key === undefined
                  ? null
                  : Array.isArray(current) && typeof key === "number"
                    ? ((current as ReadonlyArray<Json>)[key] ?? null)
                    : isRecord(current) && typeof key === "string"
                      ? (current[key] ?? null)
                      : null;
            }
            return current;
          });
        case "pick":
          return Effect.gen(function* () {
            const target = yield* go(expr.target);
            const keys = (yield* all(expr.keys)).flatMap((key) =>
              typeof key === "string" ? [key] : [],
            );
            const pick = (value: Json): Json =>
              isRecord(value)
                ? Object.fromEntries(
                    keys.filter((key) => key in value).map((key) => [key, value[key] as Json]),
                  )
                : null;
            return Array.isArray(target) ? (target as ReadonlyArray<Json>).map(pick) : pick(target);
          });
        case "map":
        case "filter":
          return Effect.gen(function* () {
            const coll = yield* go(expr.coll);
            if (!Array.isArray(coll))
              return yield* typeError(`${expr.t} needs a list.`, `${expr.site}${frames}`);
            const items = coll as ReadonlyArray<Json>;
            if (expr.t === "map" && items.length > EVAL_LIMITS.mapWidth)
              return yield* halt(
                failure(
                  "resource_exhausted",
                  "eval_map_limit",
                  `map visits at most ${EVAL_LIMITS.mapWidth} elements; this list has ${items.length}. Filter or slice it first.`,
                ),
                `${expr.site}${frames}`,
              );
            const out: Array<Json> = [];
            for (const [index, item] of items.entries()) {
              const scope = new Map(env).set(expr.name, item);
              // A call inside map is keyed by the element too, so a changed list never reuses a step.
              const value = yield* go(
                expr.body,
                scope,
                `${frames}@${expr.site}[${index}:${digest12(item)}]`,
              );
              if (expr.t === "map") out.push(value);
              else if (truthy(value)) out.push(item);
            }
            return out;
          });
        case "if":
          return Effect.flatMap(go(expr.c), (c) =>
            truthy(c) ? go(expr.a) : expr.b === undefined ? Effect.succeed(null) : go(expr.b),
          );
        case "eq":
          return Effect.flatMap(go(expr.a), (a) => Effect.map(go(expr.b), (b) => sameJson(a, b)));
        case "not":
          return Effect.map(go(expr.x), (x) => !truthy(x));
        case "try":
          return go(expr.body, env, frames, true).pipe(
            Effect.map((value): Json => ({ status: "ok", value })),
            Effect.catchTags({
              EvalHalt: (stopped) =>
                stopped.catchable
                  ? Effect.succeed(stopped.result as unknown as Json)
                  : Effect.fail(stopped),
            }),
          );
      }
    };

    const runInfo = () => ({ evalRunId, operations: state.operations });
    const outcome = yield* evaluate(
      opened.program.root,
      new Map(Object.entries(opened.bindings)),
      "",
      false,
    ).pipe(
      Effect.filterOrFail(
        (value) => bytesOf(value) <= EVAL_LIMITS.resultBytes,
        () =>
          halt(
            failure(
              "resource_exhausted",
              "eval_result_limit",
              `The result is over ${EVAL_LIMITS.resultBytes} bytes. Pick fewer fields.`,
            ),
            "run",
          ),
      ),
      Effect.timeoutOrElse({
        duration: EVAL_LIMITS.timeoutMs,
        orElse: () =>
          Effect.fail(
            state.inflightWrite === undefined
              ? halt(
                  failure(
                    "timeout",
                    "eval_timeout",
                    `The run passed ${EVAL_LIMITS.timeoutMs / 1000} s. Resume it to continue.`,
                  ),
                  "run",
                )
              : halt(unknownOutcome(state.inflightWrite, undefined), state.inflightWrite),
          ),
      }),
      Effect.result,
    );
    const settled = outcome._tag === "Success" ? "completed" : "halted";
    yield* journal
      .settleRun(evalRunId, claimId, settled)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("goat_eval could not record its run's end", { cause }).pipe(
            Effect.andThen(journal.abandonRun(claimId)),
          ),
        ),
      );
    if (outcome._tag === "Success")
      return {
        status: "ok",
        value: outcome.success,
        ...runInfo(),
        steps: { live: state.live, restored: state.restored },
      } satisfies EvalResult;
    const { at } = outcome.failure;
    // Each step's own meta stays with its journal record; the run reports its handles itself.
    const { meta: _meta, ...result } = outcome.failure.result;
    return {
      ...result,
      ...runInfo(),
      haltedAt: at,
      completedSteps: state.completed,
    } satisfies EvalResult;
  });

  return { run };
};

const runIdFor = (environmentId: string, principal: string, clientRequestId: string) =>
  `evr_${NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${principal}\0${clientRequestId}`)
    .digest("hex")
    .slice(0, 32)}`;

/** A program refused before anything ran, as a result; any other throw is a bug and stays one. */
const attempt = <A>(read: () => A): A | ErrorEnvelope => {
  try {
    return read();
  } catch (error) {
    if (error instanceof ProgramRefusal) return failure(error.code, error.reason, error.message);
    throw error;
  }
};
