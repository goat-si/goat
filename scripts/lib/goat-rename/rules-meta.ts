import type { KeepRule, TextRule } from "./engine.ts";

/**
 * GOAT meta outside the product tree: the dev container, issue templates, contribution links, the
 * .env.example header, comments and docs that name GOAT's own homes and commands, fixtures, and test
 * titles that call GOAT "T3". Each pattern matches only the old spelling in its own file.
 * Plan: devlog/_chase/10.014_t3_chase_rename_leftovers.md.
 */
const at =
  (...paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path);
const inDevcontainer = (path: string) => path.startsWith(".devcontainer/");
const inIssueTemplates = (path: string) => path.startsWith(".github/ISSUE_TEMPLATE/");

const rule = (
  id: string,
  scope: (path: string) => boolean,
  find: RegExp,
  replace: string,
): TextRule => ({
  id: `meta:${id}`,
  category: "meta",
  find,
  replace,
  scope,
});

const GOAT_IDEAS = "https://github.com/goat-si/goat/discussions/categories/ideas";

export const META_TEXT_RULES: readonly TextRule[] = [
  // The dev container: product name, port labels and cache volumes. Its GOAT_HOME stays on the
  // workspace .t3, which holds an existing container's state; an explicit home skips the legacy fallback.
  rule("devcontainer-product", inDevcontainer, /\bT3 Code\b/g, "GOAT"),
  rule(
    "devcontainer-port-labels",
    inDevcontainer,
    /(?<="label": ")t3(?= (?:web|server)\b)/g,
    "GOAT",
  ),
  rule(
    "devcontainer-volumes",
    inDevcontainer,
    /(?<=source=)t3code-(?=pnpm-store|node-modules-)/g,
    "goat-",
  ),
  rule(
    "devcontainer-home-comment",
    inDevcontainer,
    /(?<=workspace \.t3), matching$/g,
    ", which holds",
  ),
  rule(
    "devcontainer-home-comment-2",
    inDevcontainer,
    /(?<=^\s*\/\/ )the worktree default(?=\. An explicit)/g,
    "an existing container's state",
  ),
  rule(
    "devcontainer-home-doc",
    at("docs/internals/devcontainer.md"),
    /mirroring the worktree default/g,
    "where an existing container already keeps its state",
  ),
  rule(
    "devcontainer-connect-notice",
    inDevcontainer,
    /optional: enable T3 Connect cloud features/g,
    "optional: Connect config (GOAT Connect is coming soon)",
  ),
  // Issue forms and contribution links that GitHub shows on GOAT's own repository.
  rule("issue-triage-command", inIssueTemplates, /\b(?:npx )?t3 (?=triage\b)/g, "goat "),
  rule(
    "ideas-discussions",
    (path) => inIssueTemplates(path) || path === "CONTRIBUTING.md",
    /https:\/\/github\.com\/pingdotgg\/t3code\/discussions\/categories\/ideas/g,
    GOAT_IDEAS,
  ),
  // The header of .env.example: the values are upstream's public identifiers, and GOAT keeps Connect off.
  rule(
    "env-example-header",
    at(".env.example"),
    /^# Optional: T3 Connect source builds$/g,
    "# Optional: public T3 Connect configuration from upstream's production deployment.",
  ),
  rule(
    "env-example-enable",
    at(".env.example"),
    /^# `cp \.env\.example \.env` enables T3 Connect against the production deployment\.$/g,
    "# GOAT Connect is off in every build, so copying this file to .env enables nothing yet.",
  ),
  // Comments and docs about GOAT's own project file, launcher, homes and runtime paths.
  rule(
    "knip-project-file",
    at("knip.jsonc"),
    /(?<=worktree setup \(from )t3\.json(?=\))/g,
    "goat.json",
  ),
  rule(
    "launcher-package-comments",
    at("vite.config.ts"),
    /(?<=The `)t3(?=` npm launcher)/g,
    "goat",
  ),
  rule("npm-package-comment", at("knip.jsonc"), /(?<=The `)t3(?=` npm package)/g, "@goat-si/goat"),
  rule(
    "dev-runner-worktree-home",
    at("scripts/dev-runner.ts"),
    /(?<=that worktree's own |\(gitignored\) `)\.t3(?= so dev state|` — see)/g,
    ".goat",
  ),
  rule(
    "observability-home-paths",
    at("docs/operations/observability.md"),
    /(?<=`~\/|\$HOME\/|`<worktree>\/|\$WORKTREE\/)\.t3(?=[/}])/g,
    ".goat",
  ),
  // The default home is .goat, but an install whose state is still only in .t3 keeps using it (resolveGoatHome).
  rule(
    "observability-home-fallback",
    at("docs/operations/observability.md"),
    /(?<=\(so `~\/\.goat\/userdata\/\.\.\.` by default), or$/g,
    ", `~/.t3/userdata/...` while only that legacy home holds state, or",
  ),
  rule(
    "observability-home-fallback-snippets",
    at("docs/operations/observability.md"),
    /^state under the base directory's `userdata` folder:$/g,
    "state under the base directory's `userdata` folder. An install whose state is still only in `~/.t3` keeps using it, so set `GOAT_HOME=~/.t3` there first:",
  ),
  rule(
    "observability-worktree-fallback",
    at("docs/operations/observability.md"),
    /^A dev server started from a linked worktree defaults to that worktree's local home:$/g,
    "A dev server started from a linked worktree defaults to that worktree's local home (its `.t3` while only that one holds the state):",
  ),
  // The worktree and implicit dev commands pick the home as resolveGoatHome does: .goat when it holds the state,
  // otherwise a .t3 that does. The quoted "$X/.t3" stays outside observability-home-paths.
  rule(
    "observability-worktree-command",
    at("docs/operations/observability.md"),
    /^TRACE_FILE="\$WORKTREE\/\.goat\/userdata\/logs\/server\.trace\.ndjson"$/g,
    'STATE_HOME="$WORKTREE/.goat"; [ -d "$STATE_HOME/userdata" ] || [ ! -d "$WORKTREE/.t3"/userdata ] || STATE_HOME="$WORKTREE/.t3"; TRACE_FILE="$STATE_HOME/userdata/logs/server.trace.ndjson"',
  ),
  rule(
    "observability-dev-command",
    at("docs/operations/observability.md"),
    /^TRACE_FILE="\$HOME\/\.goat\/dev\/logs\/server\.trace\.ndjson"$/g,
    'STATE_HOME="$HOME/.goat"; [ -d "$STATE_HOME/dev" ] || [ ! -d "$HOME/.t3"/dev ] || STATE_HOME="$HOME/.t3"; TRACE_FILE="$STATE_HOME/dev/logs/server.trace.ndjson"',
  ),
  rule(
    "observability-dev-fallback",
    at("docs/operations/observability.md"),
    /^Only an implicit dev run outside a linked worktree uses the shared dev directory:$/g,
    "Only an implicit dev run outside a linked worktree uses the shared dev directory (`~/.t3/dev` while only that one exists):",
  ),
  rule(
    "observability-pid-fallback",
    at("docs/operations/observability.md"),
    /^different process, so check the pid first\.$/g,
    "different process, so check the pid first. On an install still using `~/.t3`, set `GOAT_HOME=~/.t3` first.",
  ),
  rule(
    "dev-runner-home-flag",
    at("scripts/dev-runner.ts"),
    /(?<=Explicit )T3 Code(?= data directory)/g,
    "GOAT",
  ),
  rule(
    "release-wsl-runtime-path",
    at("docs/operations/release.md"),
    /(?<=`~\/)\.t3(?=\/wsl-runtime\/)/g,
    ".goat",
  ),
  // Fixtures and examples that stand for GOAT itself.
  rule(
    "release-smoke-assets",
    at("scripts/release-smoke.ts"),
    /\bT3-Code-(?=9\.9\.9-smoke)/g,
    "GOAT-",
  ),
  rule(
    "dev-runner-sandbox",
    at("scripts/dev-runner.test.ts"),
    /(?<=\/tmp\/)t3code-(?=dev-runner)/g,
    "goat-",
  ),
  rule(
    "showcase-temp-dir",
    at("scripts/mobile-showcase.ts"),
    /\bt3-(?=mobile-showcase-)/g,
    "goat-",
  ),
  rule(
    "title-evaluation-request",
    at("apps/server/scripts/threadTitleEvaluationCases.ts"),
    /(?<=improve title gen(?:eration| further) in )T3 Code(?=\?)/g,
    "GOAT",
  ),
  rule(
    "example-bundle-id",
    at("apps/mobile/app.config.ts", "apps/mobile/README.md"),
    /(?<=com\.example\.)t3code\b/g,
    "goat",
  ),
];

// Test titles that name GOAT "T3". Only the quoted title changes; fixture values keep their legacy spelling.
// Not here: runtimeModel.test.ts "shares a T3 tool name", whose GOAT title already belongs to a copy of that test.
export const TEST_TITLES: readonly (readonly [path: string, from: string, to: string])[] = [
  [
    "apps/desktop/gnome-extension/captureFeedback.test.js",
    "waits for T3 to remap and cancels that wait when disabled",
    "waits for GOAT to remap and cancels that wait when disabled",
  ],
  [
    "apps/desktop/src/app/DesktopCliShim.test.ts",
    "keeps the install's T3 home under sudo, unless one is set",
    "keeps the install's GOAT home under sudo, unless one is set",
  ],
  [
    "apps/desktop/src/snapShot/KdeSnapShot.test.ts",
    "captures with verified identity, cleans private files, and activates only the owning T3 PID/title",
    "captures with verified identity, cleans private files, and activates only the owning GOAT PID/title",
  ],
  [
    "apps/desktop/src/snapShot/NiriSnapShot.test.ts",
    "does not activate T3 until requested, then matches PID and title",
    "does not activate GOAT until requested, then matches PID and title",
  ],
  [
    "apps/desktop/src/snapShot/NiriSnapShot.test.ts",
    "waits for the restored T3 window to map instead of polling",
    "waits for the restored GOAT window to map instead of polling",
  ],
  [
    "apps/desktop/src/snapShot/SnapShotAccessibilityProcess.test.ts",
    "keeps T3 alive when Zoom crashes accessibility extraction",
    "keeps GOAT alive when Zoom crashes accessibility extraction",
  ],
  [
    "apps/mobile/src/features/threads/use-composer-command-menu.test.ts",
    "still applies the T3 plan command for supported providers",
    "still applies the GOAT plan command for supported providers",
  ],
  [
    "apps/mobile/src/lib/threadActivity.test.ts",
    "uses canonical T3 orchestration summaries in compact work groups",
    "uses canonical GOAT orchestration summaries in compact work groups",
  ],
  [
    "apps/server/src/git/GitManager.test.ts",
    "a git read in flight during a T3 git action does not outlive it",
    "a git read in flight during a GOAT git action does not outlive it",
  ],
  [
    "apps/server/src/observability/OtlpEndpointCheck.test.ts",
    "keeps T3 credentials paired with each running signal endpoint",
    "keeps GOAT credentials paired with each running signal endpoint",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts",
    "sends append launch arguments to Claude after the T3 instructions",
    "sends append launch arguments to Claude after the GOAT instructions",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
    "derives concrete Codex turn policies from every T3 runtime mode",
    "derives concrete Codex turn policies from every GOAT runtime mode",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
    "preserves T3 context on the wire and restores it after compaction",
    "preserves GOAT context on the wire and restores it after compaction",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "gives a resumed session T3's rules when it was made with others",
    "gives a resumed session GOAT's rules when it was made with others",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "breaks the thread and forgets it when the session was deleted outside T3",
    "breaks the thread and forgets it when the session was deleted outside GOAT",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "stops the requests a session still waits on when a restarted T3 loads it",
    "stops the requests a session still waits on when a restarted GOAT loads it",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "declines a form T3 cannot show with the reason, instead of leaving it open",
    "declines a form GOAT cannot show with the reason, instead of leaving it open",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "re-registers T3 MCP each turn and drops its instructions when adding fails",
    "re-registers GOAT MCP each turn and drops its instructions when adding fails",
  ],
  [
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "keeps thread-scoped T3 waits as dynamic tools through their lifecycle",
    "keeps thread-scoped GOAT waits as dynamic tools through their lifecycle",
  ],
  [
    "apps/server/src/project/AgentSessionScanner.test.ts",
    "excludes the home directory, temporary root, and T3 data directory",
    "excludes the home directory, temporary root, and GOAT data directory",
  ],
  [
    "apps/server/src/provider/acp/AcpSessionRuntime.processTree.test.ts",
    "re-admits a still-owned child after PID reuse and never signals the T3 session",
    "re-admits a still-owned child after PID reuse and never signals the GOAT session",
  ],
  [
    "apps/server/src/serviceLauncher.test.ts",
    "a fresh launcher clears a restart deferred by t3 update",
    "a fresh launcher clears a restart deferred by goat update",
  ],
  [
    "apps/server/src/textGeneration/AntigravityTextGeneration.test.ts",
    "uses the native default without sending T3's default selection as a model ID",
    "uses the native default without sending GOAT's default selection as a model ID",
  ],
  [
    "apps/web/src/components/chat/MessagesTimeline.browser.test.tsx",
    "leaves messages sent by T3 Code as full bubbles",
    "leaves messages sent by GOAT as full bubbles",
  ],
  [
    "apps/web/src/components/chat/composerPromptHistory.test.ts",
    "skips messages sent by automations, agents, and T3 Code",
    "skips messages sent by automations, agents, and GOAT",
  ],
  [
    "apps/web/src/components/files/projectFilesQueryState.test.tsx",
    "keeps t3.json and the file tree loading until the file grant arrives",
    "keeps goat.json and the file tree loading until the file grant arrives",
  ],
  [
    "packages/client-runtime/src/state/threadExecution.test.ts",
    "leaves T3 delegated tasks and ordinary threads alone",
    "leaves GOAT delegated tasks and ordinary threads alone",
  ],
  [
    "packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts",
    "installs into T3 home a package and launches its exposed command",
    "installs into GOAT home a package and launches its exposed command",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity from acp-mcp-call fallback commands",
    "recovers GOAT identity from acp-mcp-call fallback commands",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity from pi-acp title-only fallback execs",
    "recovers GOAT identity from pi-acp title-only fallback execs",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity from server-namespaced titles across titleless updates",
    "recovers GOAT identity from server-namespaced titles across titleless updates",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity across the registry agents' naming conventions",
    "recovers GOAT identity across the registry agents' naming conventions",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity from goose _meta despite LLM-rewritten titles",
    "recovers GOAT identity from goose _meta despite LLM-rewritten titles",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "recovers T3 identity from qwen serverId meta regardless of prefix format",
    "recovers GOAT identity from qwen serverId meta regardless of prefix format",
  ],
  [
    "packages/provider-acp/src/server/runtimeModel.test.ts",
    "uses the asserted server instead of a misleading T3 title",
    "uses the asserted server instead of a misleading GOAT title",
  ],
  [
    "packages/provider-grok/src/server/acpSupport.test.ts",
    "inherits the Grok CLI config when no T3 runtime mode is set",
    "inherits the Grok CLI config when no GOAT runtime mode is set",
  ],
  [
    "packages/provider-grok/src/server/acpSupport.test.ts",
    "forces Grok to ask when T3 is Supervised",
    "forces Grok to ask when GOAT is Supervised",
  ],
  [
    "packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts",
    "leaves the servers of a running T3 server alone",
    "leaves the servers of a running GOAT server alone",
  ],
  [
    "packages/provider-opencode/src/server/v2/OpenCode2Server.test.ts",
    "hands the spawned server only the T3 password",
    "hands the spawned server only the GOAT password",
  ],
  [
    "packages/provider-pi/src/server/adapter.test.ts",
    "stops provider-initiated work that has no T3 turn owner",
    "stops provider-initiated work that has no GOAT turn owner",
  ],
  [
    "packages/provider-pi/src/server/adapter.test.ts",
    "injects the T3 MCP extension and bearer when a session exists",
    "injects the GOAT MCP extension and bearer when a session exists",
  ],
  [
    "packages/provider-pi/src/server/commands.test.ts",
    "maps current Pi skill metadata to T3's user and project skill scopes",
    "maps current Pi skill metadata to GOAT's user and project skill scopes",
  ],
  [
    "packages/provider-pi/src/server/mcpInjection.test.ts",
    "pi T3 MCP injection",
    "pi GOAT MCP injection",
  ],
  [
    "packages/shared/src/goatMcpToolPresentation.test.ts",
    "recognizes every T3 tool across provider prefixes and completion suffixes",
    "recognizes every GOAT tool across provider prefixes and completion suffixes",
  ],
  [
    "packages/shared/src/mcpApp.test.ts",
    "blocks the network and T3's own origin when the app declares nothing",
    "blocks the network and GOAT's own origin when the app declares nothing",
  ],
  [
    "packages/shared/src/nodeRuntime.test.ts",
    "uses installed Node instead of the standalone T3 executable",
    "uses installed Node instead of the standalone GOAT executable",
  ],
  [
    "packages/shared/src/projectSettings.test.ts",
    "resolveProjectSettings with a t3.json",
    "resolveProjectSettings with project-file defaults",
  ],
  [
    "packages/shared/src/projectSettings.test.ts",
    "lets a project override, or a t3.json the environment defers to, keep worktree mode",
    "lets a project override, or project-file defaults the environment defers to, keep worktree mode",
  ],
  [
    "packages/shared/src/toolOutput.test.ts",
    "extracts IDs through the MCP result envelopes used by T3 summaries",
    "extracts IDs through the MCP result envelopes used by GOAT summaries",
  ],
  ["scripts/dev-runner.test.ts", "t3 home precedence", "GOAT home precedence"],
  ["apps/server/src/cli/uninstall.test.ts", "t3 uninstall launcher", "goat uninstall launcher"],
  [
    "apps/server/src/cua/CuaDriverInstallation.test.ts",
    "publishes a complete $format release in T3 home and reuses it across installer instances",
    "publishes a complete $format release in GOAT home and reuses it across installer instances",
  ],
  [
    "apps/server/src/orchestration-v2/ProjectionStore.test.ts",
    "%s shells flag only an active turn blocked solely on T3 thread waits",
    "%s shells flag only an active turn blocked solely on GOAT thread waits",
  ],
  [
    "apps/web/src/components/files/projectFilesQueryState.test.tsx",
    "preserves cached t3.json defaults and scripts during a granted refresh while %s",
    "preserves cached goat.json defaults and scripts during a granted refresh while %s",
  ],
  [
    "packages/provider-pi/src/server/mcpExtensionSource.test.ts",
    "allows annotated T3 reads in %s while gating mutations and replacements",
    "allows annotated GOAT reads in %s while gating mutations and replacements",
  ],
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Text rules run before path moves, so a test file that the identifier rules move also matches its upstream path.
const UPSTREAM_PATHS: Readonly<Record<string, string>> = {
  "packages/shared/src/goatMcpToolPresentation.test.ts":
    "packages/shared/src/t3McpToolPresentation.test.ts",
};

export const TITLE_TEXT_RULES: readonly TextRule[] = TEST_TITLES.map(([path, from, to]) =>
  rule(
    `test-title:${path}:${to}`,
    UPSTREAM_PATHS[path] === undefined ? at(path) : at(path, UPSTREAM_PATHS[path]),
    new RegExp("(?<=[\"'`])" + escapeRegExp(from) + "(?=[\"'`])", "g"),
    to,
  ),
);

export const META_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "meta:observability-legacy-home",
    // The fallback these sentences describe; held so observability-home-paths does not turn it into .goat.
    pattern:
      /`~\/\.t3\/userdata\/\.\.\.` while only that legacy home holds state|`~\/\.t3\/dev` while only that one exists/g,
    scope: (path) => path === "docs/operations/observability.md",
    holdsOnApply: true,
    reason: "An install whose state is still only in .t3 keeps using it (resolveGoatHome).",
  },
];
