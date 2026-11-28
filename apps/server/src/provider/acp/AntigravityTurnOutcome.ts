// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2ProviderFailure } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { AcpResumablePromptFailure } from "@goat/provider-acp/server/adapter";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15;
// CORTEX_STEP_STATUS_DONE.
const DONE_STEP_STATUS = 3;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// Antigravity 1.5 may state the reset only in the message: "... Resets in 4m42s.".
const RESETS_IN = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;

interface LastStep {
  readonly type: number;
  readonly status: number | null;
  readonly payload: Uint8Array | null;
  readonly reachedModel: boolean;
}

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const hasSteps =
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
          .get() !== undefined;
      return hasSteps ? read(database) : undefined;
    } finally {
      database.close();
    }
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const hasStatus =
      database.prepare("SELECT 1 FROM pragma_table_info('steps') WHERE name = 'status'").get() !==
      undefined;
    const row = database
      .prepare(
        `SELECT step_type AS type, ${hasStatus ? "status" : "NULL"} AS status,
           substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    const reachedModel =
      database
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(index, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    return {
      type: row.type,
      status: typeof row.status === "number" ? row.status : null,
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      reachedModel,
    };
  };

function resetAtFrom(text: string, now: DateTime.Utc | undefined): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Option.isSome(DateTime.make(timestamp))) return timestamp;
  const delay =
    RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1] ?? RESETS_IN.exec(text)?.[1];
  if (delay === undefined || now === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit ?? ""] ?? 0);
  }
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : undefined;
}

// Reorders STATUS_ERROR's groups to API_ERROR's: HTTP status, message, status name.
function statusError(text: string) {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc | undefined,
): OrchestrationV2ProviderFailure | AcpResumablePromptFailure | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return makeProviderFailure({
      class: "usage_limit",
      message: "You have reached your Antigravity quota for this period.",
      code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
      retryable: true,
      resetAt: resetAtFrom(text, now) ?? null,
    });
  }
  if (
    /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/.test(
      text,
    )
  ) {
    return makeProviderFailure({
      class: "provider_error",
      message:
        "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
      code: "INVALID_THINKING_SIGNATURE",
      retryable: true,
    });
  }
  if (apiError === null) {
    return makeProviderFailure({
      class: "provider_error",
      message: "Antigravity stopped this turn because of an error.",
    });
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  // A 404 before the model answered is an unknown or unentitled model; after, a transient edge error.
  const transientNotFound = httpStatus === "404" && step?.reachedModel === true;
  const failure = makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: (message ?? "").trim(),
    code: status ?? null,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, now) ?? null,
  });
  return transientNotFound ? { failure, resumeWith: "continue" } : failure;
}

const conversationSegments = ["antigravity-acp", "conversations"];

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
) {
  const typedOnly = (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean },
  ) =>
    options?.retired
      ? Effect.succeed(turnFailure(result.stopReason, undefined, undefined))
      : DateTime.now.pipe(Effect.map((now) => turnFailure(result.stopReason, undefined, now)));
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise(async () => {
    const root = await antigravityProfileRoot(profileDirectory);
    if (root === undefined) return undefined;
    if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
      return undefined;
    }
    const database = await antigravityManagedPath(root, segments, "file");
    // A path that exists but fails the proof is a link or other foreign entry.
    if (database === undefined) {
      const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
        () => true,
        () => false,
      );
      return present ? undefined : { root, identity: undefined, startIndex: -1 };
    }
    return { root, identity: database.info, startIndex: undefined };
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return typedOnly;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return typedOnly;
  }
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean },
  ) {
    // The same file as before the prompt, or one this prompt created, still unlinked.
    const after = yield* Effect.tryPromise(() =>
      antigravityManagedPath(before.root, segments, "file"),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const sameFile =
      after !== undefined &&
      (before.identity === undefined ||
        (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    const step = sameFile
      ? yield* readSteps(after.path, lastStepAfter(startIndex)).pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not read the Antigravity session log after the prompt."),
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    const retired = options?.retired === true;
    const now = retired ? undefined : yield* DateTime.now;
    const failure = turnFailure(result.stopReason, step, now);
    // The reply finished but session/prompt never answered.
    const finished =
      retired &&
      failure === undefined &&
      step?.type === PLANNER_RESPONSE_STEP_TYPE &&
      step.status === DONE_STEP_STATUS;
    return finished ? ("completed" as const) : failure;
  });
});
