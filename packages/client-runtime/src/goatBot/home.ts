import {
  compareGoatBotHomeClaims,
  type EnvironmentId,
  type GoatBotHomeClaim,
} from "@goat/contracts";

export interface GoatBotHomeTarget {
  readonly environmentId: EnvironmentId;
  readonly supportsHome: boolean;
  readonly supportsBot: boolean;
  readonly connected: boolean;
  readonly settingsLoaded: boolean;
  readonly home: GoatBotHomeClaim | null;
}

export type GoatBotHomeResolution =
  | { readonly state: "unknown" }
  | { readonly state: "unclaimed" }
  | {
      readonly state: "claimed";
      readonly claim: GoatBotHomeClaim;
      readonly homeConnected: boolean;
      readonly homeSupportsBot: boolean;
      readonly staleTargetIds: ReadonlyArray<EnvironmentId>;
    };

/** Resolve raw settings snapshots before choosing a home or planning replication. */
export function resolveGoatBotHome({
  targets,
}: {
  targets: ReadonlyArray<GoatBotHomeTarget>;
}): GoatBotHomeResolution {
  if (targets.some((target) => target.connected && target.supportsHome && !target.settingsLoaded)) {
    return { state: "unknown" };
  }

  let claim: GoatBotHomeClaim | null = null;
  for (const target of targets) {
    if (!target.supportsHome || !target.settingsLoaded || target.home === null) continue;
    if (claim === null || compareGoatBotHomeClaims(target.home, claim) > 0) claim = target.home;
  }
  if (claim === null) return { state: "unclaimed" };

  const winner = claim;
  const home = targets.find((target) => target.environmentId === winner.environmentId);
  return {
    state: "claimed",
    claim: winner,
    homeConnected: home?.connected ?? false,
    homeSupportsBot: home?.supportsBot ?? false,
    staleTargetIds: targets
      .filter(
        (target) =>
          target.connected &&
          target.supportsHome &&
          target.settingsLoaded &&
          (target.home === null ||
            compareGoatBotHomeClaims(target.home, winner) !== 0 ||
            target.home.environmentId !== winner.environmentId),
      )
      .map((target) => target.environmentId),
  };
}

/** Advance the observed logical clock so moving home still works after clock rollback. */
export function newGoatBotHomeClaim({
  environmentId,
  now,
  observedMax,
  randomId,
}: {
  environmentId: EnvironmentId;
  now: number;
  observedMax: GoatBotHomeClaim | null;
  randomId: () => string;
}): GoatBotHomeClaim {
  return {
    environmentId,
    claimedAt: Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.trunc(now), (observedMax?.claimedAt ?? -1) + 1),
    ),
    claimId: randomId(),
  };
}

/**
 * Use this preference order only after resolving an unclaimed cluster. A client with a primary
 * machine never puts the bot on another machine by itself: the bot stays where it already lives,
 * else on the primary, and a remote becomes home only when the user picks it. Clients with no
 * primary (hosted web) take the first machine that supports the bot.
 */
export function pickGoatBotHomeCandidate({
  targets,
  knownBotEnvironmentId,
  primaryEnvironmentId,
}: {
  targets: ReadonlyArray<GoatBotHomeTarget>;
  knownBotEnvironmentId: EnvironmentId | null;
  primaryEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const eligible = targets.filter(
    (target) => target.connected && target.supportsHome && target.supportsBot,
  );
  return (
    (
      eligible.find((target) => target.environmentId === knownBotEnvironmentId) ??
      eligible.find((target) => target.environmentId === primaryEnvironmentId) ??
      (primaryEnvironmentId === null ? eligible[0] : undefined)
    )?.environmentId ?? null
  );
}

export interface GoatBotHomeAttempt {
  readonly failures: number;
  readonly lastAttemptAt: number;
}
export type GoatBotHomeAttempts = ReadonlyMap<string, GoatBotHomeAttempt>;

export function goatBotHomeAttemptKey(claimId: string, environmentId: EnvironmentId): string {
  return `${claimId}:${environmentId}`;
}

export type GoatBotHomeAttemptEvent =
  | { readonly type: "claim-changed"; readonly claimId: string | null }
  | { readonly type: "success"; readonly claimId: string; readonly environmentId: EnvironmentId }
  | {
      readonly type: "start" | "failure";
      readonly claimId: string;
      readonly environmentId: EnvironmentId;
      readonly now: number;
    };

/** Keep retry history immutable; clear a target's entry on success or reconnection. */
export function reduceGoatBotHomeAttempts(
  attempts: GoatBotHomeAttempts,
  event: GoatBotHomeAttemptEvent,
): GoatBotHomeAttempts {
  if (event.type === "claim-changed") {
    const prefix = event.claimId === null ? null : `${event.claimId}:`;
    return new Map([...attempts].filter(([key]) => prefix !== null && key.startsWith(prefix)));
  }
  const next = new Map(attempts);
  const key = goatBotHomeAttemptKey(event.claimId, event.environmentId);
  if (event.type === "success") {
    next.delete(key);
  } else {
    next.set(key, {
      failures: (attempts.get(key)?.failures ?? 0) + (event.type === "failure" ? 1 : 0),
      lastAttemptAt: event.now,
    });
  }
  return next;
}

/** Call again at nextWakeAt even without a new settings snapshot; callers own timers and in-flight writes. */
export function planGoatBotHomeSync({
  resolution,
  attempts,
  inFlight,
  now,
}: {
  resolution: GoatBotHomeResolution;
  attempts: GoatBotHomeAttempts;
  inFlight: ReadonlySet<string>;
  now: number;
}): {
  writes: Array<{ environmentId: EnvironmentId; claim: GoatBotHomeClaim }>;
  nextWakeAt: number | null;
} {
  const writes: Array<{ environmentId: EnvironmentId; claim: GoatBotHomeClaim }> = [];
  let nextWakeAt: number | null = null;
  if (resolution.state !== "claimed") return { writes, nextWakeAt };

  for (const environmentId of resolution.staleTargetIds) {
    const key = goatBotHomeAttemptKey(resolution.claim.claimId, environmentId);
    if (inFlight.has(key)) continue;
    const attempt = attempts.get(key);
    const delay =
      !attempt || attempt.failures === 0
        ? 0
        : attempt.failures === 1
          ? 2_000
          : attempt.failures === 2
            ? 8_000
            : attempt.failures === 3
              ? 30_000
              : 60_000;
    const retryAt = !attempt || attempt.failures === 0 ? now : attempt.lastAttemptAt + delay;
    if (retryAt > now) {
      nextWakeAt = nextWakeAt === null ? retryAt : Math.min(nextWakeAt, retryAt);
    } else {
      writes.push({ environmentId, claim: resolution.claim });
    }
  }
  return { writes, nextWakeAt };
}
