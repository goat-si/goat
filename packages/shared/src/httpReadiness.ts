import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";

const DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS = 1_000;

/**
 * Normalizes an arbitrary readiness probe failure into a plain, structured value
 * suitable for diagnostic logging. Preserves the tagged-error `_tag` (and
 * message/cause) shape for Effect tagged errors while recursing through nested
 * `cause`/`reason` chains.
 */
export function describeReadinessCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const tag = (cause as { readonly _tag?: unknown })._tag;
    const nested = (cause as { readonly cause?: unknown }).cause;
    return {
      ...(typeof tag === "string" ? { _tag: tag } : { name: cause.name }),
      message: cause.message,
      ...(nested === undefined ? {} : { cause: describeReadinessCause(nested) }),
    };
  }
  if (typeof cause !== "object" || cause === null) {
    return cause;
  }

  const record = cause as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record._tag === "string" ? { _tag: record._tag } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(record.reason === undefined ? {} : { reason: describeReadinessCause(record.reason) }),
    ...(record.cause === undefined ? {} : { cause: describeReadinessCause(record.cause) }),
  };
}

/**
 * Generic HTTP readiness probe shared by the SSH tunnel and the desktop backend
 * manager. Polls `baseUrl + path` until it returns a 2xx response or the overall
 * `timeoutMs` elapses. Each individual probe is bounded by `probeTimeoutMs` so a
 * single hung request cannot stall the retry loop, and the retry cadence is
 * `intervalMs` bounded to roughly `timeoutMs / intervalMs` attempts.
 *
 * With `maxProbeTimeoutMs`, every probe that times out doubles the next probe's
 * bound up to that ceiling, so a slow link (high RTT) still gets an answer
 * instead of abandoning each request just before it arrives.
 *
 * The error type is left to the caller via `makeError`, so each consumer keeps
 * its own tagged error. `makeError` is called at every failure site; callers can
 * inspect `cause` (which carries a `kind` discriminator for the probe-timeout and
 * overall-timeout cases) to reproduce phase-specific messages, or ignore it. The
 * overall-timeout cause also counts how many probes timed out versus failed
 * outright, which tells a slow server from one that is not answering.
 */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxProbeTimeoutMs?: number;
  readonly makeError: (info: {
    readonly requestUrl: string;
    readonly probeTimeoutMs: number;
    readonly attempt: number;
    readonly cause: unknown;
  }) => E;
}): Effect.fn.Return<void, E, HttpClient.HttpClient> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  let probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS;
  const maxProbeTimeoutMs = Math.max(probeTimeoutMs, input.maxProbeTimeoutMs ?? probeTimeoutMs);
  let probeTimeouts = 0;
  let probeFailures = 0;
  let lastProbeTimeoutMs = probeTimeoutMs;
  const retryPolicy = Schedule.spaced(Duration.millis(intervalMs)).pipe(
    Schedule.upTo({ times: Math.max(0, Math.ceil(timeoutMs / intervalMs)) }),
  );
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const lastProbeFailure = yield* Ref.make<unknown>(null);
  let attempt = 0;

  // Tracks errors this function itself produced via `makeError`, so the
  // pass-through guards below never double-wrap an already-constructed error
  // (mirrors the SSH original's `cause instanceof SshReadinessError` checks).
  const makeError = input.makeError;
  const madeErrors = new WeakSet<object>();
  const fail = (cause: unknown): E => {
    const error = makeError({ requestUrl, probeTimeoutMs, attempt, cause });
    if (typeof error === "object" && error !== null) {
      madeErrors.add(error);
    }
    return error;
  };
  const isMadeError = (value: unknown): value is E =>
    typeof value === "object" && value !== null && madeErrors.has(value);

  yield* Effect.logDebug("httpReadiness.start", {
    baseUrl: input.baseUrl,
    requestUrl,
    timeoutMs,
    intervalMs,
    probeTimeoutMs,
  });

  const readinessClient = client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.transform((effect) =>
      Effect.gen(function* () {
        attempt += 1;
        const boundMs = probeTimeoutMs;
        lastProbeTimeoutMs = boundMs;
        const responseOption = yield* effect.pipe(
          Effect.timeoutOption(Duration.millis(boundMs)),
          Effect.mapError((cause) => fail(cause)),
        );
        if (Option.isNone(responseOption)) {
          probeTimeouts += 1;
          const error = fail({ kind: "probe-timeout", attempt, probeTimeoutMs: boundMs });
          probeTimeoutMs = Math.min(maxProbeTimeoutMs, boundMs * 2);
          return yield* Effect.fail(error);
        }
        return responseOption.value;
      }).pipe(
        Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
        Effect.tapError((cause) =>
          Effect.suspend(() => {
            probeFailures += 1;
            return Ref.set(lastProbeFailure, {
              attempt,
              cause: describeReadinessCause(cause),
            });
          }),
        ),
      ),
    ),
    HttpClient.tap((response) => response.text.pipe(Effect.ignore)),
    HttpClient.retry(retryPolicy),
  );

  const result = yield* readinessClient.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
  );

  return yield* Option.match(result, {
    onSome: () =>
      Effect.logDebug("httpReadiness.succeeded", {
        baseUrl: input.baseUrl,
        requestUrl,
        attempts: attempt,
      }),
    onNone: () =>
      Effect.gen(function* () {
        const lastFailure = yield* Ref.get(lastProbeFailure);
        yield* Effect.logWarning("httpReadiness.timedOut", {
          baseUrl: input.baseUrl,
          requestUrl,
          timeoutMs,
          intervalMs,
          probeTimeoutMs,
          attempts: attempt,
          probeTimeouts,
          lastFailure,
        });
        return yield* Effect.fail(
          fail({
            kind: "overall-timeout",
            baseUrl: input.baseUrl,
            timeoutMs,
            attempts: attempt,
            probeTimeouts,
            // Probes that failed without timing out (refused, reset, non-2xx).
            otherFailures: probeFailures - probeTimeouts,
            lastProbeTimeoutMs,
            lastFailure,
          }),
        );
      }),
  });
});
