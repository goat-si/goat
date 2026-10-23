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

// Pairing/home utilities only explain legacy readers; they contain no product copy.
// Upstream has no GOAT legacy markers: these exclusions protect installed identities
// and attribution before a chase merges the renamed upstream tree.
export const VISIBLE_TEXT_RULES: readonly TextRule[] = [
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
    // Only executable subcommands registered by binCli.ts; connect is gated and
    // its onboarding guidance needs an explicit decision rather than a rename.
    // "t3 project cli" is a session label; pinnedRuntime documents legacy launchers.
    find: /\b(?:npx )?t3 (?!project cli\b)(?=(?:serve|start|pair|doctor|theme|triage|project|auth|browser|service|update|uninstall|trace|provider|thread|imessage|app|help)\b)/g,
    replace: "goat ",
    scope: (path) =>
      (isCopySurface(path) && path !== "apps/server/src/cloud/pinnedRuntime.ts") ||
      path === ".agents/skills/contribution-triage/SKILL.md",
  },
];

export const VISIBLE_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "kde-capture-desktop-name",
    pattern: /Name=T3 Code SnapShots/g,
    scope: (path) => path === kdeCapturePath,
    reason: "ADR-0014 capture identity: byte-compared readiness must accept existing installs.",
  },
  {
    id: "upstream-maintainer-text",
    pattern: /[Tt]3[^\n]*/g,
    scope: (path) => path === "AGENTS.md",
    reason: "upstream maintainer text; concurrent edit, follow-up issue",
  },
  {
    id: "older-upstream-pairing-codes",
    pattern: /older T3 Code versions/g,
    scope: (path) => path === "docs/user/remote-access.md",
    reason: "Older upstream QR codes remain supported alongside GOAT pairing links.",
  },
];
