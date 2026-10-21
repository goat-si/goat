import { describe, expect, it } from "vite-plus/test";

import { applyPathRules, applyTextRules, findResidue, isDropped } from "./engine.ts";
import { DROP_RULES, TEXT_RULES, KEEP_RULES, PATH_RULES, isExempt } from "./rules.ts";

const server = (source: string) => applyTextRules("apps/server/src/x.ts", source, TEXT_RULES).text;

describe("server service keys", () => {
  it("renames Effect keys", () => {
    expect(server('>()("t3/serverActivation") {}')).toBe('>()("goat/serverActivation") {}');
    expect(server('  "t3/orchestration-v2/EventStore/EventStoreV2",')).toBe(
      '  "goat/orchestration-v2/EventStore/EventStoreV2",',
    );
    expect(server('Context.Reference("t3/keybindings")')).toBe(
      'Context.Reference("goat/keybindings")',
    );
  });

  it("keeps branch names", () => {
    for (const branch of ["t3/abcd1234", "t3/renamed", "t3/feature-x", "t3/ssh/12345678"]) {
      expect(server(`launchFrom("${branch}")`)).toBe(`launchFrom("${branch}")`);
    }
  });
});

describe("package scope", () => {
  it("renames the scope in imports and escaped regular expressions", () => {
    const source = 'import "@t3tools/shared/path";\nconst pkg = /node_modules\\/@t3tools\\//;';
    expect(applyTextRules("scripts/x.ts", source, TEXT_RULES).text).toBe(
      'import "@goat/shared/path";\nconst pkg = /node_modules\\/@goat\\//;',
    );
  });
});

describe("env names", () => {
  const rename = (source: string) =>
    applyTextRules("apps/server/src/x.ts", source, TEXT_RULES).text;

  it("maps every legacy prefix to GOAT_", () => {
    expect(rename("env.T3CODE_HOME, env.T3_MCP_URL, env.T3_CODE_MCP_AUTHORIZATION")).toBe(
      "env.GOAT_HOME, env.GOAT_MCP_URL, env.GOAT_MCP_AUTHORIZATION",
    );
    expect(rename(String.raw`"VITE_T3CODE_WEB_SOURCEMAP", "\nT3CODE_PORT=1"`)).toBe(
      String.raw`"VITE_GOAT_WEB_SOURCEMAP", "\nGOAT_PORT=1"`,
    );
  });

  it("keeps relay keys, runner shell names and unrelated words", () => {
    const kept =
      "T3CODE_RELAY_URL VITE_T3CODE_RELAY_URL T3CODE_CLERK_PUBLISHABLE_KEY T3_ARCHIVE_VERSION T3_LOCK uint32_t";
    expect(rename(kept)).toBe(kept);
  });

  it("leaves the SSH runner untouched", () => {
    expect(applyTextRules("packages/ssh/src/tunnel.ts", "T3CODE_NO_BROWSER", TEXT_RULES).text).toBe(
      "T3CODE_NO_BROWSER",
    );
  });
});

describe("fixtures", () => {
  const rename = (source: string) => applyTextRules("apps/x.test.ts", source, TEXT_RULES).text;

  it("renames disposable temp prefixes and generated prompt ids only", () => {
    expect(rename('makeTempDirectoryScoped({ prefix: "t3code-git-manager-" })')).toBe(
      'makeTempDirectoryScoped({ prefix: "goat-git-manager-" })',
    );
    expect(rename('mkdtempSync(join(tmpdir(), "t3-launcher-"))')).toBe(
      'mkdtempSync(join(tmpdir(), "goat-launcher-"))',
    );
    expect(rename('"t3-xai-prompt-1"')).toBe('"goat-xai-prompt-1"');
    const kept = 'const link = "t3-thread://v1/x"; registerServer("t3-code");';
    expect(rename(kept)).toBe(kept);
  });
});

describe("later env and storage rules", () => {
  it("renames env wildcards and web storage keys only", () => {
    const web = (source: string) => applyTextRules("apps/web/src/x.ts", source, TEXT_RULES).text;
    expect(web("set the T3CODE_BITBUCKET_* variables")).toBe("set the GOAT_BITBUCKET_* variables");
    expect(web('const KEY = "t3code:prompt-link-opener";')).toBe(
      'const KEY = "goat:prompt-link-opener";',
    );
    const kept = 'const origin = "t3code://app";';
    expect(web(kept)).toBe(kept);
    const mobile = '"t3code:",';
    expect(applyTextRules("apps/mobile/src/pairing.ts", mobile, TEXT_RULES).text).toBe(mobile);
  });
});

describe("client dotted ids", () => {
  it("renames dotted ids but not the t3.json source label", () => {
    const web = (source: string) => applyTextRules("apps/web/src/x.ts", source, TEXT_RULES).text;
    expect(web('const KEY = "t3.backgroundActivity.clientId";')).toBe(
      'const KEY = "goat.backgroundActivity.clientId";',
    );
    expect(web('source === "t3.json"')).toBe('source === "t3.json"');
    const kept = 'fixture("t3.chat"); key("t3.pullRequests.preferences");';
    expect(web(kept)).toBe(kept);
  });
});

describe("wp9 internal names", () => {
  const rename = (path: string, source: string) => applyTextRules(path, source, TEXT_RULES).text;

  it("renames local home configuration without changing the bootstrap payload", () => {
    expect(rename("apps/desktop/src/app/DesktopStatePaths.ts", "input.t3Home")).toBe(
      "input.goatHome",
    );
    expect(rename("apps/server/src/cli/config.ts", "env.t3Home")).toBe("env.goatHome");
    expect(rename("packages/contracts/src/desktopBootstrap.ts", "t3Home")).toBe("t3Home");
    expect(
      rename(
        "apps/desktop/src/backend/DesktopBackendConfiguration.test.ts",
        "config.bootstrap.t3Home",
      ),
    ).toBe("config.bootstrap.t3Home");
    expect(rename("apps/desktop/src/app/DesktopCliShim.ts", "%t3_exit% %t3_codepage%")).toBe(
      "%goat_exit% %goat_codepage%",
    );
  });

  it("renames guest CSS and attributes with their producers and consumers", () => {
    expect(
      rename(
        "apps/desktop/src/preview/PickPreload.ts",
        "var(--t3-primary) data-t3code-annotation-tool",
      ),
    ).toBe("var(--goat-primary) data-goat-annotation-tool");
    expect(
      rename("apps/desktop/src/preview/RecordingCursor.ts", "data-t3code-recording-agent-cursor"),
    ).toBe("data-goat-recording-agent-cursor");
    expect(rename("apps/desktop/src/preview/CdpRelay.ts", '"t3-preview-page"')).toBe(
      '"goat-preview-page"',
    );
    expect(rename("apps/web/src/browser/x.ts", '"persist:t3-preview-work"')).toBe(
      '"persist:t3-preview-work"',
    );
  });

  it("renames DOM ids and the mobile icon generator together", () => {
    expect(rename("apps/web/src/pierre-icons.ts", "t3-file-icon-agents")).toBe(
      "goat-file-icon-agents",
    );
    expect(rename("apps/mobile/scripts/sync-pierre-file-icons.mjs", "t3-file-icon-agents")).toBe(
      "goat-file-icon-agents",
    );
    expect(rename("apps/web/src/x.ts", "t3-draft-hero-transition t3-ghostty-input")).toBe(
      "goat-draft-hero-transition goat-ghostty-input",
    );
  });

  it("renames helper temp prefixes and the VCS harness template", () => {
    expect(rename("apps/server/src/x.test.ts", 'makeTempDir("t3code-codex-home-")')).toBe(
      'makeTempDir("goat-codex-home-")',
    );
    expect(
      rename("apps/server/src/x.test.ts", 'prefix: opts?.prefix ?? "t3code-workspace-entries-"'),
    ).toBe('prefix: opts?.prefix ?? "goat-workspace-entries-"');
    expect(
      rename(
        "apps/server/src/vcs/testing/VcsDriverContractHarness.ts",
        "prefix = `t3-${input.kind}-vcs-contract-`",
      ),
    ).toBe("prefix = `goat-${input.kind}-vcs-contract-`");
  });
});

describe("wp9 compatibility scopes", () => {
  it("keeps recorded input and upstream/generated assets out of apply and check", () => {
    for (const path of [
      "apps/server/replay/a.ndjson",
      "pnpm-lock.yaml",
      "apps/marketing/a.ts",
      "infra/relay/a.ts",
      ".devcontainer/devcontainer.json",
      "assets/icon.svg",
    ]) {
      expect(isExempt(path)).toBe(true);
    }
    expect(isExempt("apps/server/src/a.ts")).toBe(false);
  });

  it("keeps legacy test input only inside test scopes", () => {
    const source = "T3CODE_HOME t3code:draft:v1 .t3 t3-thread:// t3Home t3McpApp octocat/t3code";
    expect(findResidue("apps/server/src/a.test.ts", source, KEEP_RULES)).toEqual([]);
    expect(findResidue("apps/server/src/a.ts", source, KEEP_RULES)).toHaveLength(1);
  });

  it("keeps native identities and operator services", () => {
    expect(
      findResidue(
        "apps/mobile/a.ts",
        "t3-source-text T3SourceTextView T3MenuDismissTouchGate T3WorkspaceNavigationView T3PresentationSources t3-agent-alert t3-agent-activity",
        KEEP_RULES,
      ),
    ).toEqual([]);
    expect(
      findResidue(
        "apps/server/src/cloud/relayTracing.ts",
        't3code-server "service.namespace": "t3code"',
        KEEP_RULES,
      ),
    ).toEqual([]);
    expect(
      findResidue("apps/desktop/a.ts", "t3-resource-monitor t3code-desktop", KEEP_RULES),
    ).toHaveLength(1);
  });

  it("renames installed and operator identities on an upstream sync", () => {
    const rename = (path: string, text: string) => applyTextRules(path, text, TEXT_RULES).text;
    expect(rename("scripts/a.ts", "t3-resource-monitor t3-browser-secret.exe")).toBe(
      "goat-resource-monitor goat-browser-secret.exe",
    );
    expect(rename("apps/mobile/src/a.tsx", 'className="font-t3-bold text-sm"')).toBe(
      'className="font-goat-bold text-sm"',
    );
    expect(
      rename(
        "apps/server/src/config.ts",
        'serviceName: "t3code-server", "service.namespace": "t3code", "service.runtime": "t3-server"',
      ),
    ).toBe(
      'serviceName: "goat-server", "service.namespace": "goat", "service.runtime": "goat-server"',
    );
    expect(rename("packages/ssh/src/tunnel.ts", '"t3.runtime.source"')).toBe(
      '"goat.runtime.source"',
    );
    expect(
      rename(
        "apps/server/src/process/agentScope.ts",
        '"app-t3code-agents.slice" `t3code-${name}-x.scope`',
      ),
    ).toBe('"app-goat-agents.slice" `goat-${name}-x.scope`');
  });
});

describe("remaining local symbols and compatibility contracts", () => {
  it("renames every local producer and consumer with stable suffixes", () => {
    expect(
      applyTextRules(
        "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
        "CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS CLAUDE_T3_MCP_TOOL_TIMEOUT_MS",
        TEXT_RULES,
      ).text,
    ).toBe("CLAUDE_READ_ONLY_GOAT_MCP_ALLOWED_TOOLS CLAUDE_GOAT_MCP_TOOL_TIMEOUT_MS");
    expect(
      applyTextRules(
        "apps/server/src/preview/ServerBrowserPage.ts",
        "window.__t3Recorder",
        TEXT_RULES,
      ).text,
    ).toBe("window.__goatRecorder");
    expect(
      applyTextRules(
        "apps/web/src/index.css",
        "::highlight(t3-thread-find) @keyframes t3-mobile-composer-old",
        TEXT_RULES,
      ).text,
    ).toBe("::highlight(goat-thread-find) @keyframes goat-mobile-composer-old");
    expect(
      applyTextRules("apps/web/src/lib/desktopPasteAsText.ts", '"t3:paste-as-text"', TEXT_RULES)
        .text,
    ).toBe('"goat:paste-as-text"');
    expect(
      applyTextRules("apps/server/src/git/GitManager.ts", '"t3code-pr-body-"', TEXT_RULES).text,
    ).toBe('"goat-pr-body-"');
    expect(
      applyTextRules("packages/shared/src/otelEnvironment.ts", "t3.value", TEXT_RULES).text,
    ).toBe("goat.value");
    expect(
      applyTextRules("apps/server/scripts/migrate-dev-db.test.ts", "[goatDir, t3Dir]", TEXT_RULES)
        .text,
    ).toBe("[goatDir, legacyDir]");
  });

  it("explains persisted metadata, OS identities and protocol samples", () => {
    for (const [path, source] of [
      ["apps/desktop/src/app/DesktopAppIdentity.ts", "t3codeCommitHash"],
      ["apps/desktop/src/app/DesktopEnvironment.ts", '"com.t3tools.T3Code.Development.desktop"'],
      ["apps/server/src/cli/invocation.ts", '"./bin/t3.js"'],
      ["packages/contracts/src/providerSetup.ts", '"t3"'],
      ["apps/mobile/src/native/a.ts", "RCTT3SourceTextViewProtocol T3PresentationSourceView"],
      ["apps/mobile/src/features/showcase/showcaseAgentActivity.ts", "t3_kind"],
      ["packages/shared/src/goatMcpToolPresentation.ts", "t3_thread_start"],
      ["packages/shared/src/codexAuthHandoff.ts", '"t3code-dev"'],
    ]) {
      expect(findResidue(path!, source!, KEEP_RULES)).toEqual([]);
    }
  });

  it("still reports a new unclassified product identifier", () => {
    expect(
      findResidue("apps/server/src/new.ts", 'const t3NewFeature = "t3-new-feature";', KEEP_RULES),
    ).toHaveLength(1);
  });
});

describe("wp9 final safety boundaries", () => {
  it("keeps legacy cgroup lease recognition inputs while renaming real temp roots", () => {
    const path = "apps/server/src/provider/acp/AcpSessionRuntime.processTree.test.ts";
    const source = 'writeSibling(`t3-acp-${deadPid}-aaaa`, "0")';
    expect(applyTextRules(path, source, TEXT_RULES).text).toBe(source);
    expect(applyTextRules(path, 'mkdtempSync(join(tmpdir(), "t3-acp-"))', TEXT_RULES).text).toBe(
      'mkdtempSync(join(tmpdir(), "goat-acp-"))',
    );
  });

  it("renames only local routing tags and temporary showcase probes", () => {
    expect(
      applyTextRules(
        "apps/server/src/pullRequest/PullRequestService.ts",
        '"t3/PullRequestService/routingCredential"',
        TEXT_RULES,
      ).text,
    ).toBe('"goat/PullRequestService/routingCredential"');
    expect(
      applyTextRules("scripts/mobile-showcase.ts", "`t3-showcase-wake-${udid}.png`", TEXT_RULES)
        .text,
    ).toBe("`goat-showcase-wake-${udid}.png`");
  });

  it("keeps regex readers for legacy schemes and remote error messages", () => {
    expect(
      findResidue("packages/shared/src/promptLinks.ts", "/^t3code(?:-[a-z]+)?:$/", KEEP_RULES),
    ).toEqual([]);
    expect(
      findResidue(
        "packages/client-runtime/src/errors/transport.ts",
        "/Unable to connect to the T3 server WebSocket\\./i",
        KEEP_RULES,
      ),
    ).toEqual([]);
  });
});

describe("test residue stays useful after fixture classification", () => {
  it("reports new internal identifiers even in tests", () => {
    expect(
      findResidue("apps/server/src/new.test.ts", "const t3NewFeature = 1;", KEEP_RULES),
    ).toHaveLength(1);
    expect(
      findResidue(
        "apps/server/src/new.test.ts",
        'const repository = "t3tools/t3code";',
        KEEP_RULES,
      ),
    ).toEqual([]);
  });
});

describe("repository hygiene on an upstream checkout", () => {
  it("moves the skills and the root project file, not look-alikes", () => {
    expect(applyPathRules(".agents/skills/test-t3-mobile/scripts/pair-client.sh", PATH_RULES)).toBe(
      ".agents/skills/test-goat-mobile/scripts/pair-client.sh",
    );
    expect(applyPathRules("t3.json", PATH_RULES)).toBe("goat.json");
    for (const path of ["apps/marketing/src/pages/schema/t3.json.ts", "apps/web/t3.json"]) {
      expect(applyPathRules(path, PATH_RULES)).toBe(path);
    }
  });

  it("drops root Cursor rules only", () => {
    expect(isDropped(".cursor/rules/cursor-cloud.mdc", DROP_RULES)).toBe(true);
    expect(isDropped("apps/web/src/.cursor/x", DROP_RULES)).toBe(false);
  });

  it("renames skill mentions in prose", () => {
    expect(
      applyTextRules("AGENTS.md", "use `test-t3-app` or $test-t3-mobile", TEXT_RULES).text,
    ).toBe("use `test-goat-app` or $test-goat-mobile");
  });
});
