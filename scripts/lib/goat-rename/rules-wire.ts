import type { KeepRule, TextRule } from "./engine.ts";

// Explicit paths keep peer identities, frozen partitions and test fixtures outside these renames.
const source = (path: string, paths: readonly string[]) => paths.includes(path);

export const WIRE_TEXT_RULES: readonly TextRule[] = [
  {
    id: "wire-guest-session-cookie",
    category: "wire",
    find: /(?<=`)t3_guest_/g,
    replace: "goat_guest_",
    scope: (path) => path === "packages/contracts/src/guestShare.ts",
  },
  {
    id: "wire-browser-session-fixture",
    category: "wire",
    find: /(?<=sessionCookieName: ")t3_session(?=")/g,
    replace: "goat_session",
    scope: (path) => path === "apps/web/test/fakeEnvironment.ts",
  },
  {
    id: "wire-private-diff-theme",
    category: "wire",
    find: /\bt3-light\b/g,
    replace: "goat-light",
    scope: (path) =>
      source(path, [
        "apps/web/src/components/DiffWorkerPoolProvider.tsx",
        "apps/web/src/lib/readableSyntaxTheme.ts",
      ]),
  },
  {
    id: "wire-release-resource-attribute",
    category: "wire",
    find: /\bt3code\.release\.channel\b/g,
    replace: "goat.release.channel",
    scope: (path) =>
      source(path, [
        "packages/shared/src/releaseResource.ts",
        "packages/shared/src/releaseResource.test.ts",
        "docs/operations/observability.md",
      ]),
  },
  {
    id: "wire-desktop-mode-attribute",
    category: "wire",
    find: /\bt3code\.desktop\.mode\b/g,
    replace: "goat.desktop.mode",
    scope: (path) => path === "apps/desktop/src/app/DesktopObservability.ts",
  },
  {
    id: "wire-orchestration-metrics",
    category: "wire",
    find: /(?<=")t3_(?=orchestration_command)/g,
    replace: "goat_",
    scope: (path) => path === "apps/server/src/observability/Metrics.ts",
  },
  {
    id: "wire-mobile-render-counter",
    category: "wire",
    find: /(?<!T3 Code.*)__t3RenderCounter(?!.*T3 Code)/g,
    replace: "__goatRenderCounter",
    scope: (path) =>
      source(path, [
        "apps/mobile/src/features/development/render-counter.ts",
        "apps/mobile/scripts/measure-renders.mts",
      ]),
  },
  {
    id: "wire-codex-context-writer",
    category: "wire",
    find: /(?<!T3 Code.*)\bt3_code_(?!.*T3 Code)/g,
    replace: "goat_code_",
    scope: (path) => source(path, ["apps/server/src/provider/CodexDeveloperInstructions.ts"]),
  },
  {
    id: "wire-preview-worlds",
    category: "wire",
    find: /(?<!T3 Code.*)(?<=["'`])t3-preview(?=["'`-])(?!.*T3 Code)/g,
    replace: "goat-preview",
    scope: (path) =>
      source(path, [
        "apps/server/src/preview/ServerBrowser.ts",
        "apps/server/src/preview/ServerBrowserPage.ts",
      ]),
  },
  {
    id: "wire-acp-correlation",
    category: "wire",
    find: /(?<!T3 Code.*)(?<=`)t3-cli-(?!.*T3 Code)/g,
    replace: "goat-cli-",
    scope: (path) => path === "apps/server/src/mcp/AcpMcpStdioBridge.ts",
  },
  {
    id: "wire-mobile-measure-scheme",
    category: "wire",
    find: /(?<!T3 Code.*)(?<=Flag\.withDefault\(")t3code-dev(?="\))(?!.*T3 Code)/g,
    replace: "goat-dev",
    scope: (path) => path === "apps/mobile/scripts/measure-renders.mts",
  },
];

export const WIRE_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "wire-acp-empty-selection",
    pattern: /_t3\/empty/g,
    scope: (path) => path === "packages/provider-acp/src/server/sessionConfig.ts",
    reason:
      "Saved selections and older clients return this ACP empty-choice sentinel; keep its writer and reader identical (R6/N6).",
  },
  {
    id: "wire-mobile-image-cache",
    pattern: /t3-attachment:/g,
    scope: (path) => path === "apps/mobile/src/lib/assetImageSource.ts",
    reason:
      "Existing device image-cache entries use this prefix; keep it until the cache reader supports legacy lookup (D-CACHE).",
  },
  {
    id: "wire-html-bridge-legacy-namespace",
    // Only the two comments that describe the legacy namespace; a new t3/ writer must still fail.
    pattern: /(?<=, and in )t3\/(?= to a client)|(?<=from then on; )t3\/(?= still)/g,
    scope: (path) => path === "packages/shared/src/htmlRender.ts",
    reason:
      "Saved HTML pages and older clients still speak the t3/ bridge methods, so the bridge documents how it answers them (#944, #966).",
  },
  {
    id: "wire-handoff-legacy-thread-read",
    pattern: /\(\?:t3\|goat\)_thread_read/g,
    scope: (path) => path === "apps/server/src/orchestration-v2/ContextHandoffDelivery.ts",
    reason:
      "Saved coverage records name t3_thread_read from before the MCP rename; delivery rewrites both spellings to goat_call (#1052).",
  },
  {
    id: "wire-codex-legacy-acp-mcp-aliases",
    pattern: /(?<=shell_environment_policy\.set\.)T3_ACP_MCP_(?:ENDPOINT|AUTHORIZATION)\b/g,
    scope: (path) =>
      source(path, [
        "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
        "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.subagents.test.ts",
        "apps/server/src/orchestration-v2/Adapters/CodexReplay.testkit.ts",
        "packages/effect-codex-app-server/src/replay.test.ts",
      ]),
    holdsOnApply: true,
    reason:
      "Codex thread config sets each ACP MCP credential under its legacy T3_ name beside the GOAT_ one (withLegacyEnvNames); these tests pin both keys (#1039, #1059).",
  },
];
