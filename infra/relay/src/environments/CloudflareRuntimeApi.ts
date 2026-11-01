import * as CloudflareRetry from "@distilled.cloud/cloudflare/Retry";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CloudflareApiPause from "./CloudflareApiPause.ts";

export class CloudflareApiPaused extends Schema.TaggedError<CloudflareApiPaused>()(
  "CloudflareApiPaused",
  { retryAfterMillis: Schema.Number },
) {
  override get message(): string {
    return `Cloudflare API calls are paused for ${this.retryAfterMillis}ms after a rate limit`;
  }
}

export function isCloudflareRateLimited(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (
    "_tag" in cause &&
    (cause._tag === "TooManyRequests" ||
      cause._tag === "CloudflareRateLimited" ||
      cause._tag === "CloudflareApiPaused")
  ) {
    return true;
  }
  if ("status" in cause && cause.status === 429) {
    return true;
  }
  return "cause" in cause && isCloudflareRateLimited(cause.cause);
}

const CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE = Duration.seconds(30);
const CLOUDFLARE_MAX_RATE_LIMIT_PAUSE = Duration.minutes(2);

function cloudflareRateLimitPauseMillis(cause: unknown): number {
  const retryAfter =
    typeof cause === "object" && cause !== null && "retryAfter" in cause
      ? cause.retryAfter
      : undefined;
  const pause = Duration.isDuration(retryAfter) ? retryAfter : CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE;
  return Duration.toMillis(Duration.min(pause, CLOUDFLARE_MAX_RATE_LIMIT_PAUSE));
}

/**
 * How long a caller should wait before retrying, when `cause` is a Cloudflare
 * rate limit or a call refused during the pause that follows one.
 */
export function cloudflareRetryAfterMillis(cause: unknown): number | undefined {
  for (let current = cause, depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("_tag" in current && current._tag === "CloudflareApiPaused") {
      const retryAfterMillis: unknown = Reflect.get(current, "retryAfterMillis");
      return typeof retryAfterMillis === "number" ? retryAfterMillis : undefined;
    }
    if (
      ("_tag" in current &&
        (current._tag === "TooManyRequests" || current._tag === "CloudflareRateLimited")) ||
      ("status" in current && current.status === 429)
    ) {
      return cloudflareRateLimitPauseMillis(current);
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

// The SDK's default policy sleeps through Retry-After inside the request, which
// held every caller until its timeout and kept the account over its limit.
// Rate limits surface at once instead; other transient failures still retry.
const withoutRateLimitRetries: CloudflareRetry.Factory = (lastError) => {
  const defaults = CloudflareRetry.makeDefault(lastError);
  return {
    ...defaults,
    while: (error) => !isCloudflareRateLimited(error) && (defaults.while?.(error) ?? false),
  };
};

// Every isolate rereads the shared pause at most this often, so a quiet
// period costs one query per isolate rather than one per Cloudflare call.
const CLOUDFLARE_PAUSE_REFRESH_MILLIS = 5_000;

/**
 * The rate limit is account-wide, so once one call is rejected every other
 * call is too, from any isolate. Failing them without a request leaves the
 * account room to recover instead of extending the limit.
 */
export const makeCloudflareApiGate = (alchemyRuntimeContext: Alchemy.BaseRuntimeContext) => {
  let pausedUntilMillis = 0;
  let checkedAtMillis = Number.NEGATIVE_INFINITY;
  return (pause: CloudflareApiPause.CloudflareApiPause["Service"]) => {
    const recordRateLimit = Effect.fn("relay.cloudflare_api_pause.rate_limited")(function* (
      cause: unknown,
    ) {
      const pauseMillis = cloudflareRateLimitPauseMillis(cause);
      const until = (yield* Clock.currentTimeMillis) + pauseMillis;
      pausedUntilMillis = Math.max(pausedUntilMillis, until);
      yield* Effect.annotateCurrentSpan({ "relay.cloudflare.pause_ms": pauseMillis });
      yield* pause.pauseUntil(until);
    });
    return <A, E>(
      call: Effect.Effect<A, E, Alchemy.RuntimeContext>,
    ): Effect.Effect<A, E | CloudflareApiPaused | Cause.TimeoutError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now >= pausedUntilMillis && now - checkedAtMillis >= CLOUDFLARE_PAUSE_REFRESH_MILLIS) {
          checkedAtMillis = now;
          // Read first: a 429 recorded while the read is in flight must win.
          const shared = yield* pause.pausedUntilMillis;
          pausedUntilMillis = Math.max(pausedUntilMillis, shared);
        }
        // A paused call never reaches Cloudflare, so it leaves no 429 behind.
        // Its own span keeps a storm visible to the rate-limit monitors.
        if (now < pausedUntilMillis) {
          return yield* new CloudflareApiPaused({ retryAfterMillis: pausedUntilMillis - now }).pipe(
            Effect.withSpan("relay.cloudflare_api_pause.rejected"),
          );
        }
        return yield* call.pipe(
          Effect.provideService(CloudflareRetry.Retry, withoutRateLimitRetries),
          Effect.timeout("8 seconds"),
          Effect.tapError((cause) =>
            isCloudflareRateLimited(cause) ? recordRateLimit(cause) : Effect.void,
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        );
      });
  };
};
