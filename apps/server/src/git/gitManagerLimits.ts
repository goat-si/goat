import * as Duration from "effect/Duration";

export const COMMIT_TIMEOUT_MS = 10 * 60_000;
export const STATUS_RESULT_CACHE_TTL = Duration.seconds(1);
export const STATUS_RESULT_CACHE_CAPACITY = 2_048;
export const PR_LOOKUP_CACHE_TTL = Duration.seconds(60);
export const PR_LOOKUP_NO_OPEN_PR_CACHE_TTL = Duration.minutes(5);
export const PR_LOOKUP_CACHE_CAPACITY = 2_048;
export const BRANCH_PR_LOOKUP_CONCURRENCY = 4;
export const PR_THREAD_CONTEXT_BYTES = 16_000;
