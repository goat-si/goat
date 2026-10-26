import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { isExempt, KEEP_RULES, TEXT_RULES } from "./rules.ts";

const rename = (path: string, source: string) =>
  applyTextRules(path, source, TEXT_RULES, KEEP_RULES).text;

describe("upstream chase identities", () => {
  it.each([
    [
      "apps/mobile/app.config.ts",
      '"Allow T3 Code to save images."',
      '"Allow GOAT to save images."',
    ],
    [
      "apps/server/src/orchestration-v2/Orchestrator.ts",
      '"T3 Code could not confirm"',
      '"GOAT could not confirm"',
    ],
    [
      "packages/contracts/src/orchestrationV2.ts",
      "/** Why T3 Code compacted a thread. */",
      "/** Why GOAT compacted a thread. */",
    ],
    [
      "apps/server/src/mcp/McpInvocationContext.ts",
      " * Read the T3 caller from the request fiber.",
      " * Read the GOAT caller from the request fiber.",
    ],
    [
      "packages/provider-acp/src/server/adapter.ts",
      "/** T3 policy must not auto-approve them. */",
      "/** GOAT policy must not auto-approve them. */",
    ],
    [
      "apps/server/src/cli/consoleStdin.ts",
      "// child shells or t3 processes.",
      "// child shells or goat processes.",
    ],
    [
      "packages/contracts/src/ipc.ts",
      "/** The app's bundled `t3` launcher. */",
      "/** The app's bundled `goat` launcher. */",
    ],
    ["apps/web/src/components/DiffWorkerPoolProvider.tsx", '"t3-light"', '"goat-light"'],
    ["apps/web/src/lib/readableSyntaxTheme.ts", "The t3-light color", "The goat-light color"],
    ["packages/contracts/src/guestShare.ts", "`t3_guest_${shareId}`", "`goat_guest_${shareId}`"],
    [
      "apps/web/test/fakeEnvironment.ts",
      'sessionCookieName: "t3_session"',
      'sessionCookieName: "goat_session"',
    ],
    [
      "apps/mobile/src/features/connection/permissionUpdateNotice.ts",
      '"t3code.permission-update.v1"',
      '"goat.permission-update.v1"',
    ],
    [
      "apps/web/src/components/guest/GuestPage.tsx",
      '"t3:guest-awaiting-rows"',
      '"goat:guest-awaiting-rows"',
    ],
    [
      "apps/desktop/src/app/DesktopObservability.ts",
      '"t3code.desktop.mode"',
      '"goat.desktop.mode"',
    ],
    [
      "packages/shared/src/releaseResource.ts",
      '"t3code.release.channel"',
      '"goat.release.channel"',
    ],
    [
      "packages/shared/src/releaseResource.test.ts",
      '"t3code.release.channel"',
      '"goat.release.channel"',
    ],
    [
      "apps/server/src/observability/Metrics.ts",
      '"t3_orchestration_commands_total"',
      '"goat_orchestration_commands_total"',
    ],
    [
      "apps/web/src/components/files/FilePreviewPanel.tsx",
      '"t3code.renderMermaid"',
      '"goat.renderMermaid"',
    ],
    [
      "apps/web/test/renderCounter.ts",
      'Symbol.for("t3code.renderCounter")',
      'Symbol.for("goat.renderCounter")',
    ],
    ["apps/web/vite.config.ts", '"t3code:chunk-cycle-guard"', '"goat:chunk-cycle-guard"'],
    [
      "packages/client-runtime/src/relay/managedRelayState.ts",
      "`[t3-cloud] Relay ${label}`",
      "`[goat-cloud] Relay ${label}`",
    ],
    [
      "packages/source-control-bitbucket/src/shared/definition.ts",
      ".git t3code-pr-${number}`",
      ".git goat-pr-${number}`",
    ],
    [
      "apps/mobile/README.md",
      "~/.cache/t3code/native-clients/artifacts",
      "~/.cache/goat/native-clients/artifacts",
    ],
    ["scripts/mobile-e2e.ts", '"t3code-dev"', '"goat-dev"'],
    [
      "scripts/mobile-native-client.ts",
      'prefix: "t3-native-upload-"',
      'prefix: "goat-native-upload-"',
    ],
    ["scripts/render-metrics.ts", '"t3-renders-"', '"goat-renders-"'],
    [
      "scripts/mobile-e2e/device.ts",
      "`t3-e2e-${runId}-${pose.id}`",
      "`goat-e2e-${runId}-${pose.id}`",
    ],
  ])("renames GOAT-owned text in %s idempotently", (path, source, expected) => {
    expect(rename(path, source)).toBe(expected);
    expect(rename(path, expected)).toBe(expected);
    expect(findResidue(path, expected, KEEP_RULES)).toEqual([]);
  });

  it("renames escaped lint diagnostic names alongside the plugin id", () => {
    const path = "oxlint-plugin-goat/rules/react-effect-budget.test.ts";
    const source = String.raw`output.match(/t3code\(react-effect-budget\)/g)`;
    expect(rename(path, source)).toBe(source.replace("t3code", "goat"));
    expect(rename(path, String.raw`/t3code\(unrelated\)/`)).toBe(String.raw`/t3code\(unrelated\)/`);
  });

  it("renames the escaped lint suppression regex so it recognizes goat rule ids", () => {
    const source = String.raw`/oxlint-disable-next-line[^\n]*t3code\/react-effect-budget\s+--\s*\S/`;
    const result = rename("oxlint-plugin-goat/rules/react-effect-budget.ts", source);
    expect(result).toBe(source.replace("t3code", "goat"));
    const pattern = new RegExp(result.slice(1, -1));
    expect(
      pattern.test("// oxlint-disable-next-line goat/react-effect-budget -- external sync"),
    ).toBe(true);
    expect(pattern.test("// oxlint-disable-next-line goat/react-effect-budget")).toBe(false);
  });

  it.each([
    ["apps/mobile/modules/t3-highlights/expo-module.config.json", '"T3HighlightsModule"'],
    [
      "apps/mobile/modules/t3-highlights/android/build.gradle",
      "namespace 'expo.modules.t3highlights'",
    ],
    [
      "apps/mobile/modules/t3-highlights/cpp/t3_highlights.c",
      "t3_highlights_tokenize(source, length)",
    ],
    ["apps/mobile/src/lib/highlights.ts", 'requireNativeModule("T3Highlights")'],
    ["apps/mobile/src/native/NativeScrollViewMarker.tsx", "T3NativeControls_ScrollEdgeBleed"],
    [
      "apps/mobile/modules/t3-native-controls/ios/T3ScrollEdgeBleedView.swift",
      "final class T3ScrollEdgeBleedView: ExpoView",
    ],
    [
      "apps/mobile/modules/t3-review-diff/tests/android/settings.gradle",
      "rootProject.name = 't3-review-diff-viewport-tests'",
    ],
    [
      "apps/mobile/modules/t3-terminal/ios/TerminalOutputBuffer.swift",
      "apps/mobile/modules/t3-terminal/ios/TerminalOutputBuffer.swift",
    ],
    [
      "apps/mobile/deps/react-native-screens-5.0.0-t3.45.tgz",
      "apps/mobile/deps/react-native-screens-5.0.0-t3.45.tgz",
    ],
    [
      "apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.16-558767d9.tgz",
      "apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.16-558767d9.tgz",
    ],
    ["scripts/mobile-native-client.ts", '".config/t3-task-cache/credentials.json"'],
    ["scripts/mobile-native-client.ts", 'response.headers["x-t3-digest"]'],
    ["scripts/mobile-native-client.ts", 'HttpClientRequest.setHeader("x-t3-build-ms", value)'],
    [
      "docs/operations/mobile-screens-fork.md",
      "https://github.com/pingdotgg/react-native-screens/tree/t3-v5.0.0-t3.45",
    ],
    [
      "packages/shared/src/paletteSearch.ts",
      "const pattern = `(?:${WORKTREE_BRANCH_PREFIX}|t3code)/`;",
    ],
  ])("keeps external and legacy identities in %s", (path, source) => {
    expect(rename(path, source)).toBe(source);
    expect(findResidue(path, source, KEEP_RULES)).toEqual([]);
    expect(findResidue(path, `${source}; T3 Code is ready`, KEEP_RULES)).toHaveLength(1);
  });

  it("keeps digit-bearing typo samples in search tests", () => {
    const path = "packages/shared/src/paletteSearch.test.ts";
    const source = 'rankTitles("t3coed", [thread("t3code perf audit")])';
    expect(rename(path, source)).toBe(source);
    expect(findResidue(path, source, KEEP_RULES)).toEqual([]);
  });

  it("leaves generated and vendored highlights bytes exempt", () => {
    expect(isExempt("apps/mobile/modules/t3-highlights/Vendor/highlights/highlights.c")).toBe(true);
    expect(isExempt("apps/mobile/modules/t3-highlights/cpp/t3_highlights.c")).toBe(false);
  });

  it("preserves both current and legacy ACP env aliases in the split subagent test", () => {
    const path = "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.subagents.test.ts";
    const source =
      '{ "shell_environment_policy.set.GOAT_ACP_MCP_ENDPOINT": endpoint, "shell_environment_policy.set.T3_ACP_MCP_ENDPOINT": endpoint, "shell_environment_policy.set.GOAT_ACP_MCP_AUTHORIZATION": auth, "shell_environment_policy.set.T3_ACP_MCP_AUTHORIZATION": auth }';
    expect(rename(path, source)).toBe(source);
  });
});
