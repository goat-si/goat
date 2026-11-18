import * as Duration from "effect/Duration";

const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);

export function statusUpstreamRefreshFailureCooldown(
  consecutiveFailures: number,
): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}
