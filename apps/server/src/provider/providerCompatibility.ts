import {
  ProviderSetupError,
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@goat/contracts";
import { satisfiesSemverRange } from "@goat/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
const compilePattern = (pattern: string) => {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return undefined;
  }
};
const LEGACY_VERSION_PATTERNS: Partial<Record<string, RegExp>> = {
  opencode: /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  cursor: /^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/,
  antigravity: /^(?:agy_acp_server_)?(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/,
  muse: /^(\d+\.\d+\.\d+)-R\d+(?:\.\d+)?$/,
};
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  /** Matches a reported version that is not plain X.Y.Z; its first group is the version to rate. */
  versionPattern: Schema.optionalKey(
    TrimmedNonEmptyString.pipe(
      Schema.check(Schema.makeFilter((value) => compilePattern(value) !== undefined)),
    ),
  ),
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ===
            "supported"
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  t3CodeVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const policy = policies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(t3CodeVersion, entry.t3CodeRange),
  );
  if (!policy) return undefined;
  const unprefixed = version?.replace(/^v/, "");
  // A cached manifest from before versionPattern still rates these drivers' release tags.
  const pattern = policy.versionPattern
    ? compilePattern(policy.versionPattern)
    : LEGACY_VERSION_PATTERNS[driver];
  const stable = (pattern && unprefixed?.match(pattern)?.[1]) || unprefixed;
  // GOAT versions differ from upstream, so an older cached policy cannot permit 1.4.
  const refusesLegacyAntigravity =
    driver === "antigravity" &&
    stable !== undefined &&
    /^\d+\.\d+\.\d+$/.test(stable) &&
    satisfiesSemverRange(stable, "<1.5.0");
  const status = refusesLegacyAntigravity
    ? "broken"
    : stable && /^\d+\.\d+\.\d+$/.test(stable)
      ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
        "unknown")
      : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this GOAT release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this GOAT release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this GOAT release."
          : null;
  const recommendedVersion = refusesLegacyAntigravity ? null : (policy.recommendedVersion ?? null);
  const recommendedRange = refusesLegacyAntigravity
    ? ">=1.5.12 <2"
    : (policy.recommendedRange ?? null);
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

/** The one refusal for a runtime the policy rates broken; action names how this runtime is updated. */
export function brokenRuntimeError(input: {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly version: string;
  readonly advisory: ServerProviderCompatibilityAdvisory | undefined;
  readonly action?: string;
}): ProviderSetupError | undefined {
  if (input.advisory?.status !== "broken") return undefined;
  const target =
    input.advisory.recommendedVersion ?? input.advisory.recommendedRange ?? "a newer version";
  return new ProviderSetupError({
    instanceId: input.instanceId,
    operation: "runtime",
    detail: `${input.name} ${input.version} does not work with this GOAT release. ${input.action ?? `Update ${input.name}`} to ${target}, then retry.`,
  });
}

export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const resolve = (version: string | null) =>
    resolveProviderCompatibility(policies, snapshot.driver, version) ??
    resolveProviderCompatibility(fallback, snapshot.driver, version);
  const advisory = resolve(snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion ? resolve(latestVersion) : undefined;
  const updateCommand = snapshot.versionAdvisory?.updateCommand;
  // The maintenance resolver emits this command only for confirmed Homebrew installs.
  const needsHomebrewRefresh =
    updateCommand?.startsWith("brew upgrade ") &&
    (advisory?.status === "unsupported" || advisory?.status === "broken") &&
    (latestAdvisory?.status === "unsupported" || latestAdvisory?.status === "broken");
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          message: needsHomebrewRefresh
            ? `${advisory.message} Homebrew's local package metadata may be stale. Run brew update && ${updateCommand} on this environment's host, then refresh provider status.`
            : advisory.message,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      }
    : base;
}
