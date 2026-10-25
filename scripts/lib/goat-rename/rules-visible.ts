import type { KeepRule, TextRule } from "./engine.ts";
import { isTest } from "./paths.ts";

const productName =
  /(?<![Uu]pstream |fork of \[?|original |any )T3 Code(?! versions\b| \((?:Alpha|Dev|Nightly)\)| <stage>| server\$| Test\b| Relay API)/g;
const kdeCapturePath = "apps/desktop/src/snapShot/KdeSnapShot.ts";

const isCopySurface = (path: string): boolean =>
  !isTest(path) &&
  /^(?:apps\/(?:web|mobile|desktop)\/src\/|apps\/server\/src\/|packages\/(?:client-runtime|shared)\/src\/|docs\/(?:user|operations)\/|structure\/|\.agents\/skills\/)/.test(
    path,
  ) &&
  !/^(?:apps\/server\/src\/(?:provider\/|vcs\/|sshRemote\/|cloud\/bootService\.ts$|telemetry\/AnalyticsService\.ts$|orchestration-v2\/Orchestrator\.ts$)|structure\/decisions\/|\.agents\/skills\/contribution-triage\/)/.test(
    path,
  ) &&
  !/(?:^|\/)(?:DesktopLegacyLocalStorage|DesktopSafeStorage[^/]*|relay|usageLimits)\.ts$/.test(
    path,
  ) &&
  path !== "docs/operations/mobile-app-store-screenshots.md" &&
  path !== "apps/mobile/src/features/connection/pairing.ts" &&
  path !== "packages/shared/src/goatHome.ts";

/**
 * GOAT Connect replaces T3 Connect (packages/shared/src/goatConnect.ts), so its copy follows GOAT everywhere GOAT
 * writes it, tests included. The troubleshooting guide mirrors the upstream page the help URL opens, and lines that
 * name upstream's hosted service hold through connectServiceKeeps (rules-external.ts).
 */
const isConnectCopySurface = (path: string): boolean =>
  /^(?:apps\/(?:web|mobile|desktop|server)\/src\/|packages\/(?:client-runtime|shared|contracts)\/src\/|docs\/(?:user|operations|internals)\/|structure\/)/.test(
    path,
  ) && path !== "docs/user/t3-connect-troubleshooting.md";

// Pairing/home utilities only explain legacy readers; they contain no product copy.
// Upstream has no GOAT legacy markers: these exclusions protect installed identities
// and attribution before a chase merges the renamed upstream tree.
export const VISIBLE_TEXT_RULES: readonly TextRule[] = [
  {
    id: "visible-connect-account-copy",
    category: "visible-copy",
    find: /\bT3 (Connect|[Aa]ccount)\b/g,
    replace: "GOAT $1",
    scope: isConnectCopySurface,
  },
  {
    id: "visible-connect-wrapped-profile",
    category: "visible-copy",
    find: /(?<=through )T3$/g,
    replace: "GOAT",
    scope: (path) =>
      /apps\/web\/src\/components\/clerk\/(?:T3|Goat)ConnectUserProfilePage\.tsx$/.test(path),
  },
  {
    id: "visible-connect-wrapped-identity",
    category: "visible-copy",
    find: /(?<=`connect` is the )T3$/g,
    replace: "GOAT",
    scope: (path) => path === "apps/server/src/telemetry/Identify.ts",
  },
  {
    id: "visible-connect-relay-client",
    category: "visible-copy",
    find: /\bT3 relay client\b/g,
    replace: "GOAT relay client",
    scope: (path) => path === "apps/server/src/cli/connect.ts",
  },
  {
    // Settings describe the project file GOAT reads first; the t3.json reader and source label stay.
    id: "visible-project-file-copy",
    category: "visible-copy",
    find: /(?<=(?:their|repository's) )t3\.json\b/g,
    replace: "goat.json",
    scope: (path) =>
      path === "apps/web/src/components/settings/ProjectDefaultsSettings.tsx" ||
      path === "apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx",
  },
  {
    id: "visible-project-file-search",
    category: "visible-copy",
    find: /(?<=worktree )t3\.json(?= )|(?<=worktree )t3\.json(?=")/g,
    replace: "goat.json t3.json",
    scope: (path) => path === "apps/web/src/components/settings/settingsSearch.ts",
  },
  {
    id: "visible-product-name",
    category: "visible-copy",
    // "T3 Code versions" describes upstream compatibility; older GOAT failures still rename.
    find: productName,
    replace: "GOAT",
    // KDE readiness compares the installed entry byte-for-byte (ADR-0014).
    scope: (path) => isCopySurface(path) && path !== kdeCapturePath,
  },
  {
    id: "visible-kde-copy",
    category: "visible-copy",
    find: new RegExp(`(?<!Name=)${productName.source}`, "g"),
    replace: "GOAT",
    scope: (path) => path === kdeCapturePath,
  },
  {
    id: "visible-cli-command",
    category: "visible-copy",
    // Executable subcommands registered by binCli.ts. "t3 project cli" is a session label;
    // connect onboarding stays gated, while the runtime comments below describe existing calls.
    find: /\b(?:npx )?t3 (?!project cli\b)(?=(?:serve|start|pair|doctor|theme|triage|project|auth|browser|service|update|uninstall|trace|provider|thread|imessage|app|help)\b)/g,
    replace: "goat ",
    scope: (path) =>
      isCopySurface(path) ||
      path === "packages/contracts/src/settings.ts" ||
      path === ".agents/skills/contribution-triage/SKILL.md",
  },
  {
    id: "visible-cli-launcher-comment",
    category: "visible-copy",
    find: /(?<=^[ \t]*(?:\/\/|\/\*\*?|\*)[^\n]*`)t3(?=(?:\.cmd)?`)/g,
    replace: "goat",
    scope: (path) =>
      [
        "apps/server/src/cli/consoleStdin.ts",
        "apps/server/src/cloud/pinnedRuntime.ts",
        "apps/server/src/persistence/DatabaseStorage.ts",
        "apps/server/src/serverRuntimeStartup.ts",
      ].includes(path),
  },
  {
    id: "visible-cli-connect-comment",
    category: "visible-copy",
    find: /(?<=^[ \t]*\/\/[^\n]*`)t3(?= connect\b)/g,
    replace: "goat",
    scope: (path) =>
      path === "apps/server/src/environment/ServerEnvironment.ts" ||
      path === "apps/server/src/relay/AgentAwarenessRelay.ts",
  },
];

export const VISIBLE_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "legacy-desktop-display-name",
    pattern: /T3 Code (?:<stage>|\(Alpha\))/g,
    scope: (path) =>
      ["apps/desktop/src/app/DesktopSafeStorageKeyMigration.ts", "structure/desktop.md"].includes(
        path,
      ),
    reason: "ADR-0014: encryption-key migration recognizes the old display-name format.",
  },
  {
    id: "kde-capture-desktop-name",
    pattern: /Name=T3 Code SnapShots/g,
    scope: (path) => path === kdeCapturePath,
    reason: "ADR-0014 capture identity: byte-compared readiness must accept existing installs.",
  },
  {
    id: "older-upstream-pairing-codes",
    pattern: /older T3 Code versions/g,
    scope: (path) => path === "docs/user/remote-access.md",
    reason: "Older upstream QR codes remain supported alongside GOAT pairing links.",
  },
];
