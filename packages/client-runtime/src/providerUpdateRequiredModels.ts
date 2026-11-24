import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@goat/contracts";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";

const RUNTIME_NAMES: Partial<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "the Codex CLI",
};
const HOMEBREW_STABLE_CASK = "brew upgrade --cask claude-code";
const HOMEBREW_LATEST_CASK =
  "brew uninstall --cask claude-code && brew install --cask claude-code@latest";
type UpdateRequiredProvider = Pick<
  ServerProvider,
  "driver" | "updateRequiredModels" | "versionAdvisory"
>;

function matchingModels(provider: UpdateRequiredProvider, searchQuery: string) {
  const query = searchQuery.trim().toLocaleLowerCase();
  return (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
}
function highestMinVersion(models: ReadonlyArray<{ readonly minVersion: string }>) {
  return models
    .map((model) => model.minVersion)
    .reduce((highest, version) =>
      compareSemverVersions(version, highest) > 0 ? version : highest,
    );
}
function channelLatestBelow(provider: UpdateRequiredProvider, minVersion: string) {
  const latest = provider.versionAdvisory?.latestVersion;
  return latest &&
    parseSemver(latest) &&
    parseSemver(minVersion) &&
    compareSemverVersions(latest, minVersion) < 0
    ? latest
    : null;
}
export function providerUpdateChannelLags(
  provider: UpdateRequiredProvider,
  searchQuery = "",
): boolean {
  const models = matchingModels(provider, searchQuery);
  return models.length > 0 && channelLatestBelow(provider, highestMinVersion(models)) !== null;
}
function formatModelList(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
export function formatProviderUpdateRequiredNotice(
  provider: UpdateRequiredProvider,
  searchQuery = "",
): string | null {
  const models = matchingModels(provider, searchQuery);
  if (models.length === 0) return null;
  const minVersion = highestMinVersion(models);
  const providerName =
    RUNTIME_NAMES[provider.driver] ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const version = minVersion.startsWith("v") ? minVersion : `v${minVersion}`;
  const names = formatModelList(models.map((model) => model.name));
  const latest = channelLatestBelow(provider, minVersion);
  const latestVersion = latest === null ? null : latest.startsWith("v") ? latest : `v${latest}`;
  if (
    latest &&
    provider.driver === "claudeAgent" &&
    provider.versionAdvisory?.updateCommand === HOMEBREW_STABLE_CASK
  ) {
    return `Using ${names} requires ${providerName} ${version} or newer, but the claude-code Homebrew cask only has ${latestVersion}. Switch to the claude-code@latest cask: ${HOMEBREW_LATEST_CASK}`;
  }
  if (latest)
    return `Using ${names} requires ${providerName} ${version} or newer, but the newest this install can update to is ${latestVersion}. Install ${providerName} another way or wait for a newer release.`;
  return `Update ${providerName} to ${version} or newer to use ${names}.`;
}
