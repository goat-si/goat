import { newGoatBotHomeClaim, type GoatBotHomeTarget } from "@goat/client-runtime/goatBot/home";
import {
  compareGoatBotHomeClaims,
  type EnvironmentId,
  type GoatBotHomeClaim,
} from "@goat/contracts";

/** Keep the latest issued clock even when only part of the cluster accepted it. */
export function planMobileGoatBotHomeChange(input: {
  readonly environmentId: EnvironmentId;
  readonly targets: ReadonlyArray<GoatBotHomeTarget>;
  readonly writableIds: ReadonlySet<EnvironmentId>;
  readonly currentClaim: GoatBotHomeClaim | null;
  readonly observedMax: GoatBotHomeClaim | null;
  readonly now: number;
  readonly randomId: () => string;
}) {
  const target = input.targets.find((entry) => entry.environmentId === input.environmentId);
  if (
    !target?.connected ||
    !target.supportsHome ||
    !target.supportsBot ||
    !input.writableIds.has(target.environmentId)
  )
    return null;
  const observed =
    input.currentClaim !== null &&
    (input.observedMax === null ||
      compareGoatBotHomeClaims(input.currentClaim, input.observedMax) > 0)
      ? input.currentClaim
      : input.observedMax;
  if (
    observed?.environmentId === input.environmentId &&
    input.currentClaim?.environmentId === input.environmentId
  )
    return null;
  return {
    claim: newGoatBotHomeClaim({
      environmentId: target.environmentId,
      now: input.now,
      observedMax: observed,
      randomId: input.randomId,
    }),
    targetIds: input.targets
      .filter(
        (entry) =>
          entry.connected && entry.supportsHome && input.writableIds.has(entry.environmentId),
      )
      .map((entry) => entry.environmentId),
  };
}

export async function writeMobileGoatBotHomeChange(
  change: NonNullable<ReturnType<typeof planMobileGoatBotHomeChange>>,
  write: (environmentId: EnvironmentId, claim: GoatBotHomeClaim) => Promise<boolean>,
): Promise<boolean> {
  const results = await Promise.all(
    change.targetIds.map(async (environmentId) => {
      try {
        return await write(environmentId, change.claim);
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}
