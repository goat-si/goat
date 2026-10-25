import type { PathRule, TextRule } from "./engine.ts";

/**
 * GOAT-owned names that rename one site at a time: local identifiers around GOAT Connect, labels GOAT gives
 * provider sessions and git commits, and private build and cache names. Each pattern matches only the old
 * spelling in its own file, so a second run is a no-op and an upstream chase reapplies the change.
 * Plan: devlog/_chase/10.014_t3_chase_rename_leftovers.md.
 */
const at =
  (...paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path);

// Text rules run before path moves, so files that move in the same run match both names.
const connectAccountPages = (path: string) =>
  /^apps\/web\/src\/components\/clerk\/(?:T3|Goat)ConnectAccountPages\.tsx$/.test(path);

const rule = (
  id: string,
  scope: (path: string) => boolean,
  find: RegExp,
  replace: string,
): TextRule => ({ id: `leftover:${id}`, category: "leftovers", find, replace, scope });

export const LEFTOVER_TEXT_RULES: readonly TextRule[] = [
  // Local console tags; the relay never reads them.
  rule(
    "connect-console-tags",
    (path) => /^apps\/(?:web|mobile|desktop|server)\/src\//.test(path),
    /\[t3-(connect|cloud)\]/g,
    "[goat-$1]",
  ),
  rule(
    "mobile-debug-tag",
    at("apps/mobile/src/lib/debugLog.ts"),
    /(?<=`\[)t3-(?=\$\{namespace\}\])/g,
    "goat-",
  ),
  // Local page slugs and the settings-search id. The relay route kind "t3-connect" stays (relay-wire keep).
  rule(
    "connect-profile-slug",
    connectAccountPages,
    /(?<=url: "|__experimental_startPath: "\/)t3-connect(?=")/g,
    "goat-connect",
  ),
  rule(
    "connect-mobile-slug",
    at("apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx"),
    /(?<=path: ")t3-connect(?=")/g,
    "goat-connect",
  ),
  rule(
    "connect-search-id",
    at(
      "apps/web/src/components/settings/settingsSearch.ts",
      "apps/web/src/components/settings/SavedEnvironmentRows.tsx",
    ),
    /(?<=id: "|searchableSetting\(")t3-connect(?=")/g,
    "goat-connect",
  ),
  rule(
    "connect-search-id-test",
    at("apps/web/src/components/settings/settingsSearch.test.ts"),
    /(?<=^\s*")t3-connect(?=",$)/g,
    "goat-connect",
  ),
  // Labels GOAT gives provider sessions and keys. Sessions and keys are found by id, never by these names.
  rule(
    "cursor-key-name",
    at("packages/provider-cursor/src/server/auth.ts"),
    /(?<=apiKeyName: `)T3 Code(?= - )/g,
    "GOAT",
  ),
  rule(
    "cursor-agent-name",
    at("packages/provider-cursor/src/server/adapter.ts"),
    /(?<=name: `)T3 Code(?= \$\{input\.threadId\})/g,
    "GOAT",
  ),
  rule(
    "opencode-session-title",
    at(
      "packages/provider-opencode/src/server/textGeneration.ts",
      "packages/provider-opencode/src/server/v2/textGeneration.ts",
    ),
    /(?<=title: `)T3 Code(?= \$\{input\.operation\})/g,
    "GOAT",
  ),
  // Identity on new checkpoint and stack-rebase commits. Checkpoints are found by ref and object id.
  rule(
    "checkpoint-git-name",
    at("apps/server/src/vcs/GitVcsDriver.ts"),
    /(?<=GIT_(?:AUTHOR|COMMITTER)_NAME: ")T3 Code(?=")/g,
    "GOAT",
  ),
  rule(
    "checkpoint-git-email",
    at("apps/server/src/vcs/GitVcsDriver.ts"),
    /(?<=GIT_(?:AUTHOR|COMMITTER)_EMAIL: ")t3code@users\.noreply\.github\.com(?=")/g,
    "checkpoint@goat.invalid",
  ),
  rule(
    "checkpoint-message",
    at("apps/server/src/vcs/GitVcsDriver.ts"),
    /(?<=`)t3(?= (?:snapshot|checkpoint) ref=)/g,
    "goat",
  ),
  rule(
    "stack-rebase-git-name",
    at("packages/source-control-github/src/server/githubStackRebase.ts"),
    /(?<=GIT_CONFIG_VALUE_1: ")T3 Code(?=")/g,
    "GOAT",
  ),
  rule(
    "stack-rebase-git-email",
    at("packages/source-control-github/src/server/githubStackRebase.ts"),
    /(?<=GIT_CONFIG_VALUE_2: ")noreply@t3\.codes(?=")/g,
    "noreply@goat.invalid",
  ),
  rule(
    "replay-git-identity",
    at(
      "packages/provider-testing/src/replayWorkspace.ts",
      "packages/provider-testing/src/replayWorkspace.test.ts",
    ),
    /\bT3 Code(?= Test\b)/g,
    "GOAT",
  ),
  rule(
    "replay-git-email",
    at("packages/provider-testing/src/replayWorkspace.ts"),
    /\bt3code-test(?=@example\.com)/g,
    "goat-test",
  ),
  // HTTP client label sent to forges; no credential or registration depends on it.
  rule(
    "forge-user-agent",
    at(
      "packages/source-control-github/src/server/GitHubRequestPolicy.ts",
      "packages/source-control-gitcafe/src/server/GitCafeApi.ts",
    ),
    /(?<="user-agent": ")t3code(?=")/g,
    "goat",
  ),
  rule(
    "bitbucket-clone-dir",
    at("packages/source-control-bitbucket/src/client/definition.ts"),
    /(?<=\.git )t3code-pr-(?=\$\{number\})/g,
    "goat-pr-",
  ),
  // Private build and cache names; a cold cache regenerates.
  rule(
    "desktop-compile-cache",
    at("apps/desktop/src/compileCache.ts"),
    /(?<=cacheRoot, ")t3code(?=", "compile-cache")/g,
    "goat",
  ),
  rule(
    "cli-runtime-stage",
    at("scripts/build-cli-archive.ts"),
    /(?<=name: ")t3-runtime(?=")/g,
    "goat-runtime",
  ),
  rule(
    "desktop-server-stage",
    at("scripts/build-desktop-artifact.ts"),
    /(?<=name: ")t3code-server(?=")/g,
    "goat-server",
  ),
  rule(
    "desktop-icon-temp",
    at("scripts/build-desktop-artifact.ts"),
    /(?<=prefix: ")t3code-icon-build-(?=")/g,
    "goat-icon-build-",
  ),
  rule(
    "desktop-missing-package-fixture",
    at("scripts/build-desktop-artifact.test.ts"),
    /\bt3code-deliberately-missing-package\b/g,
    "goat-deliberately-missing-package",
  ),
  rule(
    "mobile-native-client-cache",
    at("scripts/mobile-native-client.ts"),
    /(?<=\.cache\/)t3code(?=\/native-clients)/g,
    "goat",
  ),
  rule(
    "brand-asset-names",
    at("scripts/lib/brand-assets.ts", "apps/desktop/src/app/DesktopAssets.ts"),
    /(?<=assets\/prod\/|ico: ")t3-black-/g,
    "goat-black-",
  ),
  // The current app in capture fixtures; the frozen desktop entry name stays (ADR-0014).
  rule(
    "capture-fixture-app",
    at("apps/desktop/src/snapShot/DesktopSnapShot.test.ts"),
    /(?<=displayName: "|that ")T3 Code(?= \(Dev\)")|(?<=owner: \{ name: ")T3 Code(?=")|(?<=\/Applications\/)T3 Code(?=\.app")/g,
    "GOAT",
  ),
];

const BRAND_ASSETS =
  /^assets\/prod\/t3-black-(?:windows\.ico|web-favicon\.ico|web-favicon-(?:16x16|32x32)\.png|web-apple-touch-180\.png)$/;

/** Binary files the driver may move although their contents are exempt from rewriting. */
export const isMovableAsset = (path: string): boolean => BRAND_ASSETS.test(path);

export const LEFTOVER_PATH_RULES: readonly PathRule[] = [
  {
    id: "leftover:brand-asset-names",
    category: "leftovers",
    find: /(?<=^assets\/prod\/)t3-black-/g,
    replace: "goat-black-",
  },
];
