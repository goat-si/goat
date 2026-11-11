/**
 * How many times an outbox row is tried, shared by the delivery worker and restart recovery.
 *
 * @module channelDeliveryAttempts
 */

/** With exponential backoff capped at five minutes, ten attempts span about thirteen minutes. */
export const MAX_ATTEMPTS = 10;
/**
 * An answer decision is a local write that nothing else corrects, so it keeps retrying on the
 * normal path for longer: more attempts, up to ten minutes apart, before it fails.
 */
export const ANSWER_DECISION_ATTEMPTS = MAX_ATTEMPTS + 6;
export const ANSWER_DECISION_MAX_WAIT_SECONDS = 600;
