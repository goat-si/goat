import { cliReleaseChannelOf, isPublishableCliReleaseVersion } from "@goat/shared/cliRelease";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { compareExactServiceVersions } from "./serviceProtocol.ts";

/**
 * The one automatic-update policy (ADR-0019). The launcher-managed scheduler and the
 * client-launched SSH runtime both decide eligibility, rollout and the failed-target memory
 * here; they differ only in how a chosen target is activated.
 */

const HOUR = 3_600_000;

export type AutomaticUpdateChannel = "stable" | "nightly";

/** The channel a build follows on its own, or undefined for dev, PR and preview builds. */
export function automaticUpdateChannel(version: string): AutomaticUpdateChannel | undefined {
  if (!isPublishableCliReleaseVersion(version)) return undefined;
  const channel = cliReleaseChannelOf(version);
  return channel === "preview" ? undefined : channel;
}

export type AutomaticTargetVerdict =
  | "eligible"
  | "unpublished-or-preview-build"
  | "wrong-channel-or-unpublished"
  | "not-newer"
  | "previous-failure";

/**
 * Whether `targetVersion` may replace `ownVersion` without a person: same channel, strictly
 * newer, and not the target of the last failed or rolled-back replacement.
 */
export function classifyAutomaticTarget(input: {
  readonly ownVersion: string;
  readonly targetVersion: string;
  readonly failedTarget: string | undefined;
}): AutomaticTargetVerdict {
  const channel = automaticUpdateChannel(input.ownVersion);
  if (channel === undefined) return "unpublished-or-preview-build";
  if (automaticUpdateChannel(input.targetVersion) !== channel)
    return "wrong-channel-or-unpublished";
  if (compareExactServiceVersions(input.targetVersion, input.ownVersion) <= 0) return "not-newer";
  if (input.targetVersion === input.failedTarget) return "previous-failure";
  return "eligible";
}

/**
 * Picks the newest eligible target among competing requests, so clients on different builds
 * can never move the runtime backwards, sideways onto another channel, or back onto a target
 * that already rolled back.
 */
export function arbitrateAutomaticTargets(input: {
  readonly ownVersion: string;
  readonly failedTarget: string | undefined;
  readonly candidates: ReadonlyArray<string>;
}): string | undefined {
  let chosen: string | undefined;
  for (const targetVersion of input.candidates) {
    if (classifyAutomaticTarget({ ...input, targetVersion }) !== "eligible") continue;
    if (chosen === undefined || compareExactServiceVersions(targetVersion, chosen) > 0)
      chosen = targetVersion;
  }
  return chosen;
}

export const rolloutBucket = Effect.fn("server.auto_update.rollout_bucket")(function* (
  environmentId: string,
  targetVersion: string,
) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(`${environmentId}:${targetVersion}`),
  );
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % 100;
});

export function isRolloutEligible(input: {
  readonly channel: AutomaticUpdateChannel;
  readonly bucket: number;
  readonly publishedAt: string | undefined;
  readonly now: number;
}): boolean {
  const publishedAt = input.publishedAt === undefined ? NaN : Date.parse(input.publishedAt);
  const soak = input.channel === "stable" ? 48 * HOUR : 0;
  const window = input.channel === "stable" ? 72 * HOUR : 12 * HOUR;
  return (
    Number.isFinite(publishedAt) && input.now >= publishedAt + soak + (input.bucket / 100) * window
  );
}
