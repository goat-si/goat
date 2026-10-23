import type { KeepRule, TextRule } from "./engine.ts";
import { isTest } from "./paths.ts";

// These comments describe GOAT-owned runtime behavior. Other files also carry
// upstream attribution and legacy protocol explanations, so they stay out.
const COMMENT_PATHS = new Set([
  "apps/desktop/gnome-extension/captureFeedback.js",
  "apps/desktop/gnome-extension/feedbackGeometry.js",
  "apps/desktop/src/app/DesktopClerk.ts",
  "apps/desktop/src/snapShot/SnapShotTransition.ts",
  "apps/mobile/src/components/ui/NativeThemeHost.android.tsx",
  "apps/mobile/src/features/threads/McpAppWebView.tsx",
  "apps/server/scripts/acp-replay-agent.ts",
  "apps/server/scripts/record-muse-msp-replay-fixture.ts",
  "apps/server/src/cloud/pinnedRuntime.ts",
  "apps/server/src/device/DeviceHubProxy.ts",
  "apps/server/src/device/EasDeviceHost.ts",
  "apps/server/src/git/GitManager.ts",
  "apps/server/src/mcp/toolkits/project/handlers.ts",
  "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
  "apps/server/src/orchestration-v2/ProviderEventIngestor.ts",
  "apps/server/src/orchestration-v2/ProviderSessionManager.ts",
  "apps/server/src/provider/CodexManagedRuntime.ts",
  "apps/server/src/provider/antigravityAuthSupport.ts",
  "apps/server/src/server.ts",
  "apps/server/src/sourceControl/SourceControlProviderRegistry.ts",
  "apps/server/src/telemetry/Identify.ts",
  "apps/server/src/telemetry/ProviderDimensions.ts",
  "apps/server/src/vcs/GitVcsDriverCore.ts",
  "apps/server/src/vcs/VcsProcess.ts",
  "apps/server/src/vcs/worktreeRemoval.ts",
  "apps/server/src/workspace/KnownWorkspaces.ts",
  "apps/web/src/components/chat/McpAppFrame.tsx",
  "apps/web/src/components/chat/useUsageLimitsPanel.ts",
  "native/kde-snap-shot/src/feedback.qml",
  "packages/contracts/src/orchestrationV2.ts",
  "packages/contracts/src/orchestratorMcp.ts",
  "packages/contracts/src/rpc.ts",
  "packages/provider-acp/src/server/adapter.ts",
  "packages/provider-acp/src/server/sessionConfig.ts",
  "packages/provider-core/src/server/failure.ts",
  "packages/provider-core/src/server/orchestrationInstructions.ts",
  "packages/provider-cursor/src/server/skills.ts",
  "packages/provider-grok/src/server/probeEnvironment.ts",
  "packages/provider-muse/src/server/adapter.ts",
  "packages/provider-opencode/src/server/driver.ts",
  "packages/provider-opencode/src/server/v2/adapter.ts",
  "packages/provider-pi/src/server/adapter.ts",
  "packages/provider-pi/src/server/mcpExtensionSource.ts",
  "packages/provider-pi/src/server/mcpInjection.ts",
  "packages/shared/src/claudeCompaction.ts",
  "packages/shared/src/goatMcpToolPresentation.ts",
  "packages/shared/src/mcpApp.ts",
  "scripts/dev-runner.ts",
]);

const commentScope = (path: string) => !isTest(path) && COMMENT_PATHS.has(path);

export const INTERNAL_TEXT_RULES: readonly TextRule[] = [
  {
    id: "internal-masthead-artwork-comment",
    category: "comments",
    find: /T3 brand artwork/g,
    replace: "GOAT brand artwork",
    scope: (path) => path === "vite.config.ts",
  },
  {
    id: "internal-fixture-example-path",
    category: "paths",
    find: /(?<=\/tmp\/)t3-seed(?=\.sql)/g,
    replace: "goat-seed",
    scope: (path) => path === ".agents/skills/test-goat-app/references/sqlite-fixtures.md",
  },
  {
    id: "internal-provisioning-example-path",
    category: "paths",
    find: /(?<=# GOAT_MACOS_PROVISIONING_PROFILE=\/absolute\/path\/to\/)t3code(?=\.provisionprofile)/g,
    replace: "goat",
    scope: (path) => path === ".env.example",
  },
  {
    id: "internal-owned-comments",
    category: "comments",
    find: /(?<=^(?!.*T3 Code)(?!.*(?:[Ll]egacy T3|[Uu]pstream T3|[Cc]opyright))[ \t]*(?:: \/\/|\/\/|\/\*\*?|\*)[^\r\n]*)(?:\bT3(?='s\b| (?:server|MCP|home|runtime|process|git|wait|revert|tool|thread|database|session|turn|orchestration|composers|delegate_task|owns|may|starts|shows|restores|has|could|did|stops|keeps|answers|tracks|uses|never|raised|passes|asks|does|also|on)\b|-owned\b|-managed\b|[.:])|(?<=(?:but |normal |page ))T3$)/g,
    replace: "GOAT",
    scope: commentScope,
  },
  {
    id: "internal-module-runtime-comments",
    category: "comments",
    find: /(?<=^[ \t]*(?:\/\/|\/\*\*?|\*)[^\n]*)\b(?:t3(?= runtime\b)|t3code(?= modules\b))/g,
    replace: "GOAT",
    scope: (path) =>
      path === "apps/server/src/cloud/pinnedRuntime.ts" ||
      path === "packages/provider-pi/src/server/mcpExtensionSource.ts",
  },
  {
    id: "internal-expo-operations",
    category: "identifiers",
    find: /\bT3(?=ExpoViewer|EasSimulatorAvailability|CreateEasSimulatorSession|EasSimulatorSession|ActiveEasSimulatorSessions|StopEasSimulatorSession)/g,
    replace: "Goat",
    scope: (path) =>
      !isTest(path) && /^apps\/server\/src\/device\/ExpoApi\.(?:ts|graphql(?:\.ts)?)$/.test(path),
  },
  {
    id: "internal-server-workspace-filter",
    category: "packages",
    find: /(?<="--filter=)t3(?=")/g,
    replace: "goat",
    scope: (path) => path === "scripts/dev-runner.ts",
  },
  {
    id: "internal-server-build-graph",
    category: "packages",
    find: /(?<=const BUILD_ONLY_DEPS = \{ )t3(?=:)/g,
    replace: "goat",
    scope: (path) => path === ".github/scripts/ci-changes.cjs",
  },
  {
    id: "internal-warmup-names",
    category: "local-names",
    find: /t3code(?=-startup-warmup|:warm-bundled-dev)|(?<=\[)t3code(?=\])/g,
    replace: "goat",
    scope: (path) => path === "apps/web/vite/warmBundledDev.ts",
  },
  {
    id: "internal-claude-shell-label",
    category: "local-names",
    find: /(?<=")t3-claude(?=")/g,
    replace: "goat-claude",
    scope: (path) => path === "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
  },
  {
    id: "internal-capture-diagnostics",
    category: "local-names",
    find: /(?<=console\.warn\(`)T3(?= capture (?:effects|preview) unavailable:)/g,
    replace: "GOAT",
    scope: (path) =>
      /^apps\/desktop\/gnome-extension\/(?:captureFeedback|extension)\.js$/.test(path),
  },
  {
    id: "internal-project-cli-label",
    category: "local-names",
    find: /(?<=label: ")t3(?= project cli")/g,
    replace: "goat",
    scope: (path) => path === "apps/server/src/cli/project.ts",
  },
];

export const INTERNAL_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "provider-env-legacy-prefix",
    pattern:
      /(?<=^const PROVIDER_ENV_PREFIXES = \[[^\]\n]*)"T3CODE_"|(?<=^\/\/ ANTHROPIC_BASE_URL\) and the agent's own )T3(?= state\. Tests that read the ambient environment$)/g,
    scope: (path) => path === "packages/shared/src/testing/providerEnv.ts",
    reason:
      "Tests still scrub the legacy provider environment prefix; GOAT CI switches remain ambient.",
  },
];
