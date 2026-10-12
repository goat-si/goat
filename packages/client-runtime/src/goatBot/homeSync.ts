import {
  compareGoatBotHomeClaims,
  type EnvironmentId,
  type GoatBotHomeClaim,
} from "@t3tools/contracts";

import {
  goatBotHomeAttemptKey,
  newGoatBotHomeClaim,
  planGoatBotHomeSync,
  reduceGoatBotHomeAttempts,
  type GoatBotHomeAttempts,
  type GoatBotHomeResolution,
  type GoatBotHomeTarget,
} from "./home.ts";

/** Owns home claim and retry state; callers supply current snapshots, writes and timers. */
export function createGoatBotHomeSync({
  now,
  randomId,
  onSettled,
}: {
  now: () => number;
  randomId: () => string;
  onSettled: () => void;
}) {
  let attempts: GoatBotHomeAttempts = new Map();
  const inFlight = new Map<string, symbol>();
  let observedMax: GoatBotHomeClaim | null = null;
  let pendingClaim: GoatBotHomeClaim | null = null;
  let previousClaimId: string | null = null;
  let connected = new Set<EnvironmentId>();
  // Successful RPCs wait for snapshot readback rather than rewriting on every update.
  const awaitingReadback = new Map<string, object | null>();
  const snapshots = new Map<EnvironmentId, object | null>();
  let active = false;

  function update({
    targets,
    resolution,
    candidateId,
    writableIds,
    write,
  }: {
    targets: ReadonlyArray<GoatBotHomeTarget>;
    resolution: GoatBotHomeResolution;
    candidateId: EnvironmentId | null;
    writableIds: ReadonlySet<EnvironmentId>;
    write: (environmentId: EnvironmentId, claim: GoatBotHomeClaim) => Promise<boolean>;
  }): { nextWakeAt: number | null } {
    for (const target of targets) {
      const snapshot = target.home;
      if (
        target.supportsHome &&
        snapshot !== null &&
        (observedMax === null || compareGoatBotHomeClaims(snapshot, observedMax) > 0)
      )
        observedMax = snapshot;
      snapshots.set(target.environmentId, snapshot);
      if (target.connected && !connected.has(target.environmentId)) {
        for (const key of inFlight.keys()) {
          if (key.endsWith(`:${target.environmentId}`)) inFlight.delete(key);
        }
        for (const claimId of [previousClaimId, pendingClaim?.claimId]) {
          if (!claimId) continue;
          attempts = reduceGoatBotHomeAttempts(attempts, {
            type: "success",
            claimId,
            environmentId: target.environmentId,
          });
          awaitingReadback.delete(goatBotHomeAttemptKey(claimId, target.environmentId));
        }
      }
      for (const [key, previousSnapshot] of awaitingReadback) {
        if (key.endsWith(`:${target.environmentId}`) && previousSnapshot !== snapshot)
          awaitingReadback.delete(key);
      }
    }
    connected = new Set(
      targets.filter((target) => target.connected).map((target) => target.environmentId),
    );
    if (resolution.state === "unknown") return { nextWakeAt: null };
    if (resolution.state === "claimed") pendingClaim = null;
    if (resolution.state === "unclaimed" && pendingClaim === null) {
      if (candidateId === null || !writableIds.has(candidateId)) return { nextWakeAt: null };
      pendingClaim = newGoatBotHomeClaim({
        environmentId: candidateId,
        now: now(),
        observedMax: observedMax,
        randomId,
      });
    }
    const claim = resolution.state === "claimed" ? resolution.claim : pendingClaim;
    if (claim === null) return { nextWakeAt: null };
    if (previousClaimId !== claim.claimId) {
      attempts = reduceGoatBotHomeAttempts(attempts, {
        type: "claim-changed",
        claimId: claim.claimId,
      });
      awaitingReadback.clear();
      previousClaimId = claim.claimId;
    }
    const staleTargetIds = (
      resolution.state === "claimed"
        ? resolution.staleTargetIds
        : targets
            .filter((target) => target.connected && target.supportsHome)
            .map((target) => target.environmentId)
    ).filter((id) => writableIds.has(id));
    const planned = planGoatBotHomeSync({
      resolution: {
        state: "claimed",
        claim,
        homeConnected: true,
        homeSupportsBot: true,
        staleTargetIds,
      },
      attempts: attempts,
      inFlight: new Set([...inFlight.keys(), ...awaitingReadback.keys()]),
      now: now(),
    });
    for (const request of planned.writes) {
      const { environmentId } = request;
      const key = goatBotHomeAttemptKey(claim.claimId, environmentId);
      const token = Symbol();
      inFlight.set(key, token);
      attempts = reduceGoatBotHomeAttempts(attempts, {
        type: "start",
        claimId: claim.claimId,
        environmentId,
        now: now(),
      });
      const snapshot = snapshots.get(environmentId) ?? null;
      void write(environmentId, claim)
        .then((success) => {
          if (previousClaimId !== claim.claimId || inFlight.get(key) !== token) return;
          attempts = reduceGoatBotHomeAttempts(attempts, {
            type: success ? "success" : "failure",
            claimId: claim.claimId,
            environmentId,
            now: now(),
          });
          if (success && snapshots.get(environmentId) === snapshot)
            awaitingReadback.set(key, snapshot);
        })
        .finally(() => {
          if (inFlight.get(key) === token) inFlight.delete(key);
          if (active) onSettled();
        });
    }
    return { nextWakeAt: planned.nextWakeAt };
  }

  return {
    update,
    // React StrictMode may clean up and reactivate the same controller.
    setActive(value: boolean) {
      active = value;
    },
  };
}
