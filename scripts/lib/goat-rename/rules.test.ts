import { describe, expect, it } from "vite-plus/test";

import { applyPathRules, applyTextRules, findResidue, isDropped } from "./engine.ts";
import { WIRE_TEXT_RULES } from "./rules-wire.ts";
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

  it("keeps SSH runner environment handoffs", () => {
    const source = "GOAT_SPAWN_ENV='T3CODE_NO_BROWSER=1'";
    expect(
      applyTextRules("packages/ssh/src/runtimeOwnershipScripts.ts", source, TEXT_RULES).text,
    ).toBe(source);
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
  it("renames SSH auth variables outside the frozen tunnel runner", () => {
    expect(applyTextRules("packages/ssh/src/auth.ts", "T3_SSH_AUTH_SECRET", TEXT_RULES).text).toBe(
      "GOAT_SSH_AUTH_SECRET",
    );
  });
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

  it("keeps runner shell names and unrelated words", () => {
    const kept = "T3_ARCHIVE_VERSION T3_LOCK uint32_t";
    expect(rename(kept)).toBe(kept);
    expect(rename("T3CODE_RELAY_URL VITE_T3CODE_RELAY_URL T3CODE_CLERK_PUBLISHABLE_KEY")).toBe(
      "GOAT_RELAY_URL VITE_GOAT_RELAY_URL GOAT_CLERK_PUBLISHABLE_KEY",
    );
  });

  it("renames upstream SSH auth while protecting the legacy runtime handoff line", () => {
    expect(
      applyTextRules(
        "packages/ssh/src/auth.ts",
        "if ($null -ne $env:T3_SSH_AUTH_SECRET) {",
        TEXT_RULES,
      ).text,
    ).toBe("if ($null -ne $env:GOAT_SSH_AUTH_SECRET) {");
    const legacy =
      "GOAT_SPAWN_ENV='T3CODE_NO_BROWSER=1' # goat-rename: legacy: older SSH runtime handoff";
    expect(
      applyTextRules("packages/ssh/src/runtimeOwnershipScripts.ts", legacy, TEXT_RULES).text,
    ).toBe(legacy);
  });

  it("leaves the SSH runner untouched", () => {
    expect(applyTextRules("packages/ssh/src/tunnel.ts", "T3CODE_NO_BROWSER", TEXT_RULES).text).toBe(
      "T3CODE_NO_BROWSER",
    );
  });

  it("keeps the legacy ACP MCP aliases that Codex thread-config tests pin (#1059)", () => {
    const aliasLines = [
      '"shell_environment_policy.set.T3_ACP_MCP_ENDPOINT": "http://127.0.0.1:43123/mcp",',
      '"shell_environment_policy.set.T3_ACP_MCP_AUTHORIZATION",',
    ];
    for (const path of [
      "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
      "apps/server/src/orchestration-v2/Adapters/CodexReplay.testkit.ts",
      "packages/effect-codex-app-server/src/replay.test.ts",
    ]) {
      for (const line of aliasLines) {
        expect(applyTextRules(path, line, TEXT_RULES, KEEP_RULES).text).toBe(line);
        expect(
          findResidue(
            path,
            line,
            KEEP_RULES.filter((rule) => rule.holdsOnApply),
          ),
        ).toEqual([]);
      }
      expect(applyTextRules(path, "env.T3_ACP_MCP_ENDPOINT", TEXT_RULES, KEEP_RULES).text).toBe(
        "env.GOAT_ACP_MCP_ENDPOINT",
      );
    }
    expect(
      applyTextRules(
        "packages/provider-acp/src/server/adapter.ts",
        aliasLines[0]!,
        TEXT_RULES,
        KEEP_RULES,
      ).text,
    ).toBe('"shell_environment_policy.set.GOAT_ACP_MCP_ENDPOINT": "http://127.0.0.1:43123/mcp",');
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
      "infra/ingest/a.ts",
      "infra/relay/migrations/0001_init.sql",
      "assets/icon.svg",
    ]) {
      expect(isExempt(path)).toBe(true);
    }
    expect(isExempt("apps/server/src/a.ts")).toBe(false);
    // GOAT runs these, so the rules rewrite them and the check reads them.
    expect(isExempt(".devcontainer/devcontainer.json")).toBe(false);
    expect(isExempt(".github/ISSUE_TEMPLATE/config.yml")).toBe(false);
  });

  it("keeps legacy test input only inside test scopes", () => {
    const source = "T3CODE_HOME t3code:draft:v1 .t3 t3-thread:// t3Home t3McpApp octocat/t3code";
    expect(findResidue("apps/server/src/a.test.ts", source, KEEP_RULES)).toEqual([]);
    expect(findResidue("apps/server/src/a.ts", source, KEEP_RULES)).toHaveLength(1);
  });

  it("keeps native identities and operator services", () => {
    expect(
      findResidue(
        "apps/mobile/modules/t3-native-controls/ios/T3NativeControlsModule.swift",
        "t3-source-text T3SourceTextView T3MenuDismissTouchGate T3WorkspaceNavigationView T3PresentationSources t3-agent-alert t3-agent-activity",
        KEEP_RULES,
      ),
    ).toEqual([]);
    expect(isExempt("infra/relay/src/worker.ts")).toBe(false);
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
      ["apps/desktop/src/app/DesktopEnvironment.ts", '"com.t3tools.T3Code.Development.desktop"'],
      ["apps/server/src/cli/invocation.ts", '"./bin/t3.js"'],
      ["packages/contracts/src/providerSetup.ts", '"t3"'],
      [
        "apps/mobile/modules/t3-source-text/ios/T3SourceText.mm",
        "RCTT3SourceTextViewProtocol T3PresentationSourceView",
      ],
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
    for (const path of ["apps/marketing/src/pages/t3.json.ts", "apps/web/t3.json"]) {
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

const keptVisibleCopy = [
  [
    ".agents/skills/contribution-triage/SKILL.md",
    "description: Enforce T3 Code's PR contribution policy by closing ineligible submissions and triggering Macroscope review for eligible work within authorized scope. Supports explicit dry runs. Use for contribution moderation, not installation diagnostics or a full code review.",
  ],
  [
    ".github/triage/PLAYBOOK.md",
    "- How is T3 Code running on this machine: `npx t3 serve` in a terminal, the",
  ],
  [
    "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
    'const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];',
  ],
  [
    "apps/desktop/src/app/DesktopSafeStorageKeyMigration.ts",
    ' * name (`productName`, for example "GOAT" or "T3 Code (Alpha)"); `T3 Code <stage>` is checked too.',
  ],
  [
    "apps/mobile/src/features/connection/pairing.ts",
    "/** App-link protocols whose `pair` URL wraps a pairing URL; T3 Code's are kept for older QR codes. */",
  ],
  [
    "apps/server/scripts/acp-mock-agent.ts",
    '              Content: { url: "https://exa.test", content: "T3 Code page" },',
  ],
  [
    "apps/server/scripts/acp-mock-agent.ts",
    '            content: [{ type: "content", content: { type: "text", text: "T3 Code page" } }],',
  ],
  [
    "apps/server/src/cloud/bootService.ts",
    " * Installed by builds before the GOAT rename, and by upstream T3 Code. Install",
  ],
  [
    "apps/server/src/cloud/bootService.ts",
    '    .replace(/^Description=T3 Code server$/m, "Description=GOAT server")',
  ],
  [
    "apps/server/src/cloud/bootService.ts",
    "   * that serves another home is upstream T3 Code's or another install's, and",
  ],
  ["apps/server/src/provider/CodexChatGptAuth.ts", '        : { agent_name_hint: "T3 Code" }),'],
  ["apps/server/src/provider/CodexProvider.ts", 'const CODEX_CLIENT_NAME = "T3 Code";'],
  [
    "apps/server/src/telemetry/AnalyticsService.ts",
    " * Events go to the T3 Code ingest endpoint, which keeps a copy and forwards",
  ],
  ["docs/internals/overview.md", "## Upstream T3 Code"],
  [
    "docs/internals/remote-updates.md",
    "Upstream T3 Code (`pingdotgg/t3code` at `771fd93f`) only downloads on the host,",
  ],
  [
    "docs/operations/mobile-app-store-screenshots.md",
    "2. Creates T3 Code, React, and Linux Git repositories with recognizable favicons, feature branches,",
  ],
  [
    "docs/operations/mobile-app-store-screenshots.md",
    "   and a deterministic T3 Code review diff.",
  ],
  [
    "docs/operations/mobile-app-store-screenshots.md",
    "The Pending rows use the production offline outbox and point at the real T3 Code and React fixture",
  ],
  [
    "docs/user/background-service.md",
    "including one still named `t3code.service` or an upstream T3 Code install, is",
  ],
  [
    "docs/user/remote-access.md",
    "codes printed by older T3 Code versions still scan. Browsers use the",
  ],
  [
    "docs/user/remote-access.md",
    "and data under `~/.goat`, apart from any T3 Code install in `~/.t3`. A fresh host",
  ],
  ["packages/contracts/src/relay.ts", '  .annotate(OpenApi.Title, "T3 Code Relay API")'],
  [
    "packages/provider-muse/src/server/sdk.ts",
    '    clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },',
  ],
  ["packages/shared/src/goatHome.ts", " * T3 Code may be using `~/.t3` at the same time."],
  [
    "packages/shared/src/usageLimits.ts",
    "  \"I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\\n\\nGo to admin.openai.com → Workspace → Usage limits. Thank you!\";",
  ],
  [
    "README.md",
    "GOAT began as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and keeps its fast, event-sourced core. On top of it, GOAT adds:",
  ],
  [
    "README.md",
    "- **Its own desktop app.** The GOAT desktop app has its own app ID, data folder and update feed, so it installs beside the T3 Code app without sharing state. Its command line is `goat`.",
  ],
  [
    "README.md",
    "GOAT is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by Ping and shares its git history. We merge upstream every cycle, and [devlog/_chase](./devlog/_chase/README.md) records how far GOAT has followed and where it deliberately differs. Thank you to the T3 Code team for the foundation.",
  ],
  [
    "README.md",
    "MIT. [LICENSE](./LICENSE) keeps the original T3 Code copyright notice. Icons: [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).",
  ],
  [
    "scripts/build-cli-archive.ts",
    "  // Upstream T3 Code's MIT notice travels with every GOAT archive.",
  ],
  [
    "scripts/build-desktop-artifact.ts",
    "  // Upstream T3 Code's MIT notice ships with every GOAT app (staged from LICENSE).",
  ],
  [
    "scripts/lib/release-notices.ts",
    '    "GOAT includes the software listed below. GOAT is based on T3 Code; its MIT notice is in LICENSE-T3CODE.txt.",',
  ],
  ["scripts/mobile-showcase-environment.ts", '    title: "T3 Code",'],
  [
    "scripts/mobile-showcase-environment.ts",
    '      "Give T3 Code a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",',
  ],
  [
    "scripts/mobile-showcase-environment.ts",
    '      "T3 Code now treats every machine like it is right here in the room. ✦\\n\\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\\n- Terminal state follows you without losing a single line\\n- Agent work remains perfectly in sync across devices\\n- Handoffs land before your train of thought can wander\\n\\nI also ran the changed workspace: **612 tests passed**.",',
  ],
  [
    "structure/decisions/ADR-0005-desktop-home.md",
    "- 목적과 의도: Package GOAT as its own desktop app, with its own data directory and update feed, so it can sit beside an upstream T3 Code install.",
  ],
  [
    "structure/decisions/ADR-0005-desktop-home.md",
    '- 기존 구현 및 제약 조건: The message says a packaged build was still "T3 Code" with upstream\'s bundle id, Electron profile, and `~/.t3/userdata`, and that its update feed followed `GITHUB_REPOSITORY`. That could collide with an upstream install or update into upstream T3.',
  ],
  [
    "structure/decisions/ADR-0006-goat-cli-and-ssh-home.md",
    "- 검토한 주요 대안: The message does not record a third directory layout. It rejects sharing `~/.t3` on a host that also runs upstream T3 Code.",
  ],
  [
    "structure/decisions/ADR-0007-mcp-tool-names.md",
    '- 기존 구현 및 제약 조건: The message says agents saw `t3_thread_list`, `t3_ssh_thread_launch`, and the rest, from a server named "T3 Code".',
  ],
  [
    "structure/decisions/ADR-0014-desktop-runtime-identity.md",
    "  `T3 Code <stage>` on `t3code://app`, without losing saved secrets or renderer storage and with a",
  ],
  [
    "structure/decisions/ADR-0014-desktop-runtime-identity.md",
    '  from `app.name` as it stands before the event loop starts. `app.setName("T3 Code <stage>")` ran',
  ],
  [
    "structure/decisions/ADR-0014-desktop-runtime-identity.md",
    "    copy the key of the initial package name (or `T3 Code <stage>`) to the new name. All ciphertext",
  ],
  [
    "structure/decisions/ADR-0022-cua-driver-computer-use.md",
    "  - Upstream T3 Code had two open, unmerged Cua Driver stacks. The newer one (#21694-#21697, by",
  ],
  [
    "structure/desktop.md",
    "  (or `T3 Code <stage>`) to the new name before anything reads safeStorage (macOS Keychain, Linux",
  ],
  [
    "structure/overview.md",
    "GOAT is a fork of T3 Code and shares its git history. [`README.md`](../README.md) states that.",
  ],
] as const;

describe("visible GOAT copy", () => {
  it("preserves KDE capture's installed desktop entry identity (ADR-0014)", () => {
    const path = "apps/desktop/src/snapShot/KdeSnapShot.ts";
    const source = '    "Name=T3 Code SnapShots",';
    expect(applyTextRules(path, source, TEXT_RULES).text).toBe(source);
    expect(findResidue(path, source, KEEP_RULES)).toEqual([]);
    expect(applyTextRules(path, '"T3 Code capture failed"', TEXT_RULES).text).toBe(
      '"GOAT capture failed"',
    );
  });
  it.each(keptVisibleCopy)("keeps inventory copy in %s", (path, current) => {
    expect(applyTextRules(path, current, TEXT_RULES).text).toBe(current);
  });

  it("renames the connection banner and implemented CLI commands", () => {
    const path = "packages/client-runtime/src/connection/diagnosis.ts";
    const source = "T3 Code on ${host} did not answer. Run `npx t3 serve` or `t3 pair`.";
    const expected = "GOAT on ${host} did not answer. Run `goat serve` or `goat pair`.";
    const first = applyTextRules(path, source, TEXT_RULES).text;
    expect(first).toBe(expected);
    expect(applyTextRules(path, first, TEXT_RULES).text).toBe(first);
  });

  it("renames older-host failures without renaming upstream version history", () => {
    expect(server("host runs an older T3 Code")).toBe("host runs an older GOAT");
    expect(server("a T3 Code session")).toBe("a GOAT session");
    expect(server("original T3 Code; upstream T3 Code; any T3 Code install")).toBe(
      "original T3 Code; upstream T3 Code; any T3 Code install",
    );
  });

  it("keeps tests, frozen desktop identities, upstream help links and unknown commands", () => {
    for (const path of [
      "apps/web/src/copy.test.ts",
      "apps/desktop/package.json",
      "apps/desktop/scripts/electron-launcher.mjs",
      "AGENTS.md",
      "packages/ssh/src/x.ts",
      "apps/server/src/sshRemote/x.ts",
      "apps/server/src/orchestration-v2/Orchestrator.ts",
    ]) {
      const source = "T3 Code: npx t3 serve";
      expect(applyTextRules(path, source, TEXT_RULES).text).toBe(source);
    }
    const source =
      "T3 Connect: t3ConnectTroubleshootingUrl #the-host-runs-an-older-t3-code `npx t3 unknown`";
    expect(server(source)).toBe(
      "GOAT Connect: goatConnectTroubleshootingUrl #the-host-runs-an-older-t3-code `npx t3 unknown`",
    );
  });
});

describe("wire rename boundaries", () => {
  it("rewrites upstream context, counter, opaque ids and ephemeral world labels", () => {
    const cases = [
      [
        "apps/server/src/provider/CodexDeveloperInstructions.ts",
        "t3_code_development t3_code_runtime",
        "goat_code_development goat_code_runtime",
      ],
      [
        "apps/mobile/src/features/development/render-counter.ts",
        "__t3RenderCounterStart",
        "__goatRenderCounterStart",
      ],
      [
        "apps/mobile/scripts/measure-renders.mts",
        'Flag.withDefault("t3code-dev")',
        'Flag.withDefault("goat-dev")',
      ],
      [
        "apps/server/src/preview/ServerBrowser.ts",
        '"t3-preview-clipboard"',
        '"goat-preview-clipboard"',
      ],
      [
        "apps/server/src/preview/ServerBrowserPage.ts",
        '"t3-preview-metrics"',
        '"goat-preview-metrics"',
      ],
      [
        "apps/server/src/mcp/AcpMcpStdioBridge.ts",
        "`t3-cli-${nextId++}`",
        "`goat-cli-${nextId++}`",
      ],
    ] as const;
    for (const [path, input, output] of cases) {
      const renamed = applyTextRules(path, input, TEXT_RULES).text;
      expect(renamed).toBe(output);
      expect(applyTextRules(path, renamed, TEXT_RULES).text).toBe(output);
    }
  });

  it("leaves hand-owned HTML bridge declarations unchanged", () => {
    const input = 'const KEY_DOWN_METHOD = "t3/notifications/keydown";';
    expect(applyTextRules("packages/shared/src/htmlRender.ts", input, TEXT_RULES).text).toBe(input);
  });

  it("keeps relay help, ACP sentinels and cached attachment keys with precise reasons", () => {
    for (const [path, text] of [
      ["packages/provider-acp/src/server/sessionConfig.ts", '"_t3/empty" "_t3/session-mode"'],
      ["packages/shared/src/htmlRender.ts", '"t3-theme"'],
      ["apps/mobile/src/lib/assetImageSource.ts", '"t3-attachment:"'],
    ]) {
      expect(applyTextRules(path!, text!, TEXT_RULES).text).toBe(text);
      expect(findResidue(path!, text!, KEEP_RULES)).toEqual([]);
    }
    expect(
      findResidue("apps/web/src/unrelated.ts", "t3ConnectTroubleshootingUrl", KEEP_RULES),
    ).not.toEqual([]);
  });
});

it("wire rules exclude tests, protected paths and every line containing the product phrase", () => {
  const input = 't3_code_development __t3RenderCounterStart "t3-preview" `t3-cli-1`';
  for (const path of [
    "apps/server/src/provider/CodexDeveloperInstructions.test.ts",
    "packages/ssh/src/runtimeOwnershipScripts.ts",
    "apps/server/src/sshRemote/runtime.ts",
    "apps/server/src/orchestration-v2/Orchestrator.ts",
    "AGENTS.md",
    "apps/marketing/page.ts",
    ".repos/example.ts",
    "devlog/example.md",
  ]) {
    expect(applyTextRules(path, input, WIRE_TEXT_RULES).text).toBe(input);
  }
  for (const [path, name] of [
    ["apps/server/src/provider/CodexDeveloperInstructions.ts", "t3_code_runtime"],
    ["apps/mobile/src/features/development/render-counter.ts", "__t3RenderCounterStart"],
    ["apps/server/src/preview/ServerBrowser.ts", '"t3-preview-clipboard"'],
    ["apps/server/src/mcp/AcpMcpStdioBridge.ts", "`t3-cli-1`"],
  ]) {
    for (const text of [`T3 Code ${name}`, `${name} T3 Code`])
      expect(applyTextRules(path!, text, WIRE_TEXT_RULES).text).toBe(text);
  }
  expect(
    applyTextRules("packages/ssh/src/auth.ts", '"T3CODE_SSH_AUTH_SECRET"', TEXT_RULES).text,
  ).toBe('"GOAT_SSH_AUTH_SECRET"');
});
