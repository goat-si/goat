/**
 * The GOAT rename table. Each phase of the T3 removal adds its rules here;
 * `node scripts/goat-rename.ts --list` prints them. Order matters: longer,
 * more specific spellings come before shorter ones.
 *
 * Plan and reasons: devlog/_plan/261013_remove-t3-internals/000_plan.md.
 */
import type { KeepRule, PathRule, TextRule } from "./engine.ts";

/**
 * Files no rule touches and the residue check skips. Upstream-owned files
 * that GOAT does not run stay byte-identical so upstream syncs merge cleanly.
 */
export const isExempt = (path: string): boolean =>
  // Recorded protocols and generated/binary assets are upstream input, not rename output.
  /\.ndjson$|\.(?:png|jpg|jpeg|ico|icns|woff2?|ttf|wasm|pdf|svg)$/.test(path) ||
  path === "pnpm-lock.yaml" ||
  path.startsWith("apps/marketing/") ||
  path.startsWith("infra/") ||
  path.startsWith(".devcontainer/") ||
  path.startsWith(".cursor/") ||
  path.startsWith(".github/ISSUE_TEMPLATE/") ||
  path === ".github/TRIAGE_EXEMPTIONS.td" ||
  path.startsWith(".github/scripts/thread-transfer") ||
  path.startsWith(".repos/") ||
  path.startsWith("devlog/") ||
  path.startsWith("scripts/lib/goat-rename/") ||
  path === "scripts/goat-rename.ts" ||
  path.startsWith("packages/contracts/src/legacyT3Names.") ||
  /(^|\/)(LICENSE[^/]*|THIRD_PARTY_NOTICES[^/]*|UPSTREAM\.md)$/.test(path) ||
  // Disabled upstream workflows; GOAT runs only goat-*.yml.
  (path.startsWith(".github/workflows/") && !path.startsWith(".github/workflows/goat-")) ||
  // AUR packaging is published only by the disabled upstream workflow.
  path.startsWith("packaging/aur/");

export const isTest = (path: string): boolean =>
  /\.(?:test|testkit)\.[^/]+$|(?:^|\/)(?:__tests__|testkit|testFixtures|fixtures)(?:\/|$)/.test(
    path,
  );

const inLintPlugin = (path: string) => path.startsWith("oxlint-plugin-");

/**
 * Server Effect service keys: "t3/serverActivation", "t3/orchestration-v2/EventStore/...".
 * Branch names ("t3/abcd1234", "t3/renamed", "t3/feature-x", "t3/ssh/12345678") never
 * have an uppercase letter in the first segment or a second segment starting with a letter.
 */
export const SERVER_SERVICE_KEY =
  /"t3\/(?=[a-z][a-zA-Z0-9]*[A-Z]|[a-z][a-zA-Z0-9-]*\/[A-Za-z]|keybindings")/g;

/**
 * Code identifiers (plan wp4), applied to text and to file names. Substring
 * matches are intended: `useT3ProjectFileScripts` follows `T3ProjectFile`.
 * Not here on purpose: `t3McpApp` and `__t3McpAppReceive` (MCP-app wire format,
 * D17), `T3Connect*` (names the upstream service), `t3Home` (desktop bootstrap
 * key, D17), `t3CodeRange` (upstream model manifest key) and mobile native
 * modules (wp8).
 */
const IDENTIFIERS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["T3ProjectFile", "GoatProjectFile"],
  ["t3ProjectFile", "goatProjectFile"],
  ["T3Mcp", "GoatMcp"],
  ["t3Mcp(?!App)", "goatMcp"],
  ["T3Tool(?!s\\b)", "GoatTool"],
  ["t3Tool", "goatTool"],
  ["RemoteT3", "RemoteGoat"],
  ["T3Orchestration", "GoatOrchestration"],
  ["t3Orchestration", "goatOrchestration"],
  ["T3Acp", "GoatAcp"],
  ["t3Acp", "goatAcp"],
  ["T3Wordmark", "GoatWordmark"],
  ["T3CodeToolAvailability", "GoatToolAvailability"],
  ["T3CodePublicConfig", "GoatPublicConfig"],
  ["seedT3CodeWorkspace", "seedGoatWorkspace"],
  ["T3ServerConfig", "GoatServerConfig"],
  ["resolveWorktreeT3Home", "resolveWorktreeHome"],
  ["DEFAULT_T3_HOME", "DEFAULT_GOAT_HOME"],
  ["PI_T3_MCP_EXTENSION", "PI_GOAT_MCP_EXTENSION"],
  ["pi-t3-mcp-extension", "pi-goat-mcp-extension"],
  ["hasT3Extension", "hasGoatExtension"],
  ["isT3ManagedWorktree", "isGoatManagedWorktree"],
  ["t3SqliteStateCommand", "goatSqliteStateCommand"],
  ["t3-sqlite-state", "goat-sqlite-state"],
  ["\\bwithT3\\b", "withGoat"],
  ["\\bpathWithT3\\b", "pathWithGoat"],
  ["\\bt3Context\\b", "goatContext"],
  ["\\bt3Rules\\b", "goatRules"],
  ["\\bt3Url\\b", "goatUrl"],
  ["\\bt3Action\\b", "goatAction"],
  ["\\bt3File\\b", "goatFile"],
  ["\\bt3Export\\b", "goatExport"],
  ["\\bt3Requests\\b", "goatRequests"],
];

/** Marketing's public schema URL (/schema/t3.json) is upstream's; its page file keeps its name. */
const outsideMarketingSchema = (path: string) =>
  !path.startsWith("apps/marketing/src/pages/schema/");

/** Shell variables of the SSH runner script. Its bytes stay unchanged until phase 2 (plan D17). */
const SSH_RUNNER_SHELL_NAMES =
  "ARCHIVE_VERSION|STAGING|LOCK|NODE_SCRIPT_PATH|LOCK_CANDIDATE|ARCHIVE|STATE_KEY|RUNTIME_DIR|ARCHIVE_MODE|LOCK_TOKEN|RUNNER_SETUP|RELEASE_BASE_URL|READY_PROBE_TIMEOUT_MS|NODE_ENGINE_RANGE|LOCK_UNOWNED|CEILING|SSH_PROTOCOL|REUSE_READY_TIMEOUT_MS|REPLACEMENT_LOCK|PROTOCOL_TOKENS|OWNED_IDENTITY|ORCHESTRATION_PROTOCOL|NODE_ENV_SCRIPT|LOCK_WAITED|EXPECTED|STAGED_VERSION_OUTPUT|REMOTE_PORT_SCAN_WINDOW|PLATFORM|NODE_BIN|LOCK_OWNER|DEFAULT_REMOTE_PORT|ARCH|ACTUAL|WAIT_READY_SCRIPT|VERIFY_OWNED_BEFORE_PUBLICATION|TTL|SSH_UPLOADED_ARCHIVE|SELECTED_VERSION|RUNNER_SCRIPT|RUNNER_INSTALL|RETAINED_RUNNER_SHA256|REQUIRE_INSTALLED|REQUESTED_VERSION|REQUESTED_RUNNER|REFRESH_LIVE_VERSION|REFRESH_IF_IDLE|READY_TIMEOUT_MS|PROTOCOL_GUARD|PRESERVE_SELECTED_RUNNER|PICK_PORT_SCRIPT|OWNING_LAUNCH|NODE_ENGINE_CHECK_SCRIPT|LOCK_STATUS|LIVE_RUNNER_SHA256|LEGACY_IDENTITY|LABEL|EXTRA_SCOPES|EXPECTED_ARCHIVE_VERSION|CAPTURE_RUNNING_RUNNER|ARCHIVE_LOCK_WAIT_SECONDS|ARCHIVE_DOWNLOAD_SECONDS|ARCHIVE_CHECKSUMS_SECONDS|ALLOW_OWNED_UPGRADE|ALLOW_LEGACY_ADOPTION";

/** Env keys generated by the upstream T3 Connect relay (plan D7). */
const RELAY_ENV_NAMES =
  "CLERK_[A-Z0-9_]+|RELAY_URL|HOSTED_APP_URL|RELAY_CLIENT_CONFIG_ENV|WEB_ROUTER_URL|WEB_LATEST_DOMAIN|WEB_NIGHTLY_DOMAIN|(?:MOBILE|RELAY_CLIENT)_OTLP_TRACES_[A-Z]+";

/**
 * `T3CODE_X`, `T3_CODE_X` and `T3_X` become `GOAT_X` (plan D5). A name may follow a
 * `\\n` escape inside a string. Runner shell names and relay keys stay.
 */
export const ENV_NAME = new RegExp(
  String.raw`(?:(?<=\\n)|(?<![A-Za-z0-9_]))(?!T3_(?:${SSH_RUNNER_SHELL_NAMES})\b|(?:VITE_)?T3CODE_(?:${RELAY_ENV_NAMES})\b)(VITE_|EXPO_PUBLIC_)?T3(?:CODE|_CODE)?_([A-Z0-9_]*[A-Z0-9])\b`,
  "g",
);

/** The SSH runner and the fixtures that pin its bytes (plan D17). */
const outsideSshRunner = (path: string) =>
  !/^packages\/ssh\/src\/(tunnel[^/]*|fixtures\/.*)$/.test(path);

/** Lint rule ids are listed so that unrelated `t3code/...` paths and branch names stay. */
const LINT_RULE_IDS =
  "namespace-node-imports|no-global-process-runtime|no-hermes-unsupported-apis|no-inline-schema-compile|no-manual-effect-runtime-in-tests|no-mobile-uniwind-theme-escape-hatches|no-native-title-tooltip|no-outset-state-indicators|no-raw-mcp-registration|no-raw-resize-observer|no-rpc-permission-bypass|no-test-in-loop|no-unscoped-has|prefer-catch-tags|require-centered-scroll-gutter|require-suppression-reason";

export const TEXT_RULES: readonly TextRule[] = [
  {
    id: "local-home-fields",
    category: "local-names",
    find: /\bt3Home\b/g,
    replace: "goatHome",
    // These consumers use GOAT_HOME, not the D17 desktop bootstrap payload.
    scope: (path) =>
      /^scripts\/(?:dev-runner|install)\./.test(path) ||
      /^apps\/desktop\/src\/app\/Desktop(?:Config|Environment|StatePaths|CliShim|EarlyElectronStartup)(?:\.test)?\.ts$/.test(
        path,
      ) ||
      /^apps\/server\/src\/cli\/(?:app|config)\.ts$/.test(path),
  },
  ...[
    ["parentEnvWithoutT3Home", "parentEnvWithoutGoatHome"],
    ["envT3Home", "envGoatHome"],
    ["resolvedT3Home", "resolvedGoatHome"],
    ["t3_exit", "goat_exit"],
    ["t3_codepage", "goat_codepage"],
    ["t3-kernel32", "goat-kernel32"],
    ["t3-user32", "goat-user32"],
  ].map(([from, to]): TextRule => ({
    id: `local:${to}`,
    category: "local-names",
    find: new RegExp(`\\b${from}\\b`, "g"),
    replace: to!,
  })),
  {
    id: "powershell-namespace",
    category: "local-names",
    find: /(?<=-Namespace )T3\b|(?<=\[)T3(?=\.Env\])/g,
    replace: "Goat",
    scope: (path) => path.endsWith("DesktopCliCommand.ts"),
  },
  {
    id: "preview-guest-css",
    category: "preview",
    find: /--t3-/g,
    replace: "--goat-",
    scope: (path) =>
      path.startsWith("apps/desktop/src/preview/") &&
      !path.endsWith("AnnotationStyles.generated.ts"),
  },
  {
    id: "preview-session-ids",
    category: "preview",
    find: /(?<=["'`])t3-preview(?=["'`-])/g,
    replace: "goat-preview",
    scope: (path) =>
      /apps\/desktop\/src\/preview\/(?:CdpRelay|DesktopBrowserHost)(?:\.test)?\.ts$/.test(path),
  },
  {
    id: "web-dom-ids",
    category: "dom",
    find: /t3-(?=draft-hero-transition|file-icon-|ghostty-input)/g,
    replace: "goat-",
    scope: (path) =>
      path.startsWith("apps/web/") || path === "apps/mobile/scripts/sync-pierre-file-icons.mjs",
  },
  {
    id: "preview-guest-attributes",
    category: "preview",
    find: /data-t3code-(?=annotation-|recording-)/g,
    replace: "data-goat-",
    scope: (path) => path.startsWith("apps/desktop/src/preview/"),
  },

  // Packages (plan D4). Every workspace package is private; GOAT publishes no npm package.
  { id: "package-scope", category: "packages", find: /@t3tools\//g, replace: "@goat/" },
  {
    // The same scope inside a regular expression literal, as in release verification.
    id: "package-scope-escaped",
    category: "packages",
    find: /@t3tools\\\//g,
    replace: "@goat\\/",
  },
  {
    id: "cli-platform-packages",
    category: "packages",
    find: /@t3code\/t3-/g,
    replace: "@goat/cli-",
  },
  {
    // Effect service keys must start with the package name (deterministicKeys).
    id: "server-service-keys",
    category: "packages",
    find: SERVER_SERVICE_KEY,
    replace: '"goat/',
    scope: (path) => path.startsWith("apps/server/"),
  },
  // Lint plugin (plan D4).
  {
    id: "lint-plugin-dir",
    category: "tooling",
    find: /oxlint-plugin-t3code/g,
    replace: "oxlint-plugin-goat",
  },
  {
    id: "lint-rule-ids",
    category: "tooling",
    find: new RegExp(`\\bt3code/(${LINT_RULE_IDS})\\b`, "g"),
    replace: "goat/$1",
  },
  {
    id: "lint-plugin-name",
    category: "tooling",
    find: /name: "t3code"/g,
    replace: 'name: "goat"',
    scope: inLintPlugin,
  },
  {
    id: "lint-plugin-temp-prefix",
    category: "tooling",
    find: /"t3code-oxlint-"/g,
    replace: '"goat-oxlint-"',
    scope: inLintPlugin,
  },
  ...IDENTIFIERS.map(([from, to]): TextRule => ({
    id: `identifier:${to}`,
    category: "identifiers",
    find: new RegExp(from, "g"),
    replace: to,
  })),
  {
    id: "env-names",
    category: "env",
    find: ENV_NAME,
    replace: "$1GOAT_$2",
    scope: outsideSshRunner,
  },
  {
    id: "env-dev-remote-entry",
    category: "env",
    find: /\bGOAT_DEV_REMOTE_T3_SERVER_ENTRY_PATH\b/g,
    replace: "GOAT_DEV_REMOTE_SERVER_ENTRY_PATH",
  },
  {
    // Wildcard mentions such as `T3CODE_BITBUCKET_*` in messages and comments.
    id: "env-wildcards",
    category: "env",
    find: /\b(VITE_)?T3(?:CODE|_CODE)?_([A-Z0-9_]*_)\*/g,
    replace: "$1GOAT_$2*",
    scope: outsideSshRunner,
  },
  {
    // Client storage keys; reads fall back to the legacy key (plan D10). Not `t3code://`.
    id: "storage-keys",
    category: "env",
    find: /(?<=["'`])t3code:(?=[a-z])/g,
    replace: "goat:",
    scope: (path) =>
      path.startsWith("apps/web/src/") || path.startsWith("packages/client-runtime/src/"),
  },
  {
    // Dotted client ids such as "t3.backgroundActivity.clientId" or Symbol.for("t3.mobile...").
    // Not "t3.json" (the project file source), the t3.chat website, or the persisted
    // pull request list keys, whose legacy prefix the storage fallback does not map.
    id: "client-dotted-ids",
    category: "env",
    find: /(?<=["'`])t3\.(?!json\b|chat\b|pullRequests\.)(?=[a-zA-Z])/g,
    replace: "goat.",
    scope: (path) =>
      path.startsWith("apps/web/src/") ||
      path.startsWith("apps/mobile/src/") ||
      path.startsWith("packages/client-runtime/src/"),
  },
  {
    // In-process sentinels and debug globals such as __T3CODE_ENV_PATH_START__ and __T3_DEBUG__.
    id: "env-sentinels",
    category: "env",
    find: /__T3(?:CODE)?_(?=[A-Z])/g,
    replace: "__GOAT_",
    scope: outsideSshRunner,
  },
  {
    // Disposable temp directories: `prefix: "t3-..."` options and `mkdtemp(... "t3-...")` calls.
    id: "temp-prefixes",
    category: "fixtures",
    find: /(?<=(?:prefix\s*[:=]\s*|mkdtemp(?:Sync)?\(.*|makeTempDir\(.*)["'`]\.?)t3(?:code)?-(?=[a-z$])|(?<=["'`])t3(?:code)?-(?=(?:git-manager|codex-home|claude-home|workspace|codex-shared|codex-shadow-root|acp)-)|(?<=prefix\s*[:=]\s*["'`])t3-(?=\$\{input\.kind\}-vcs-contract-)/g,
    scope: (path) => isTest(path) || path.endsWith("VcsDriverContractHarness.ts"),
    replace: "goat-",
  },
  {
    // Fallback prompt ids our Grok adapter generates, and the replay fixtures that echo them.
    id: "grok-prompt-ids",
    category: "fixtures",
    find: /\bt3-xai-prompt-/g,
    replace: "goat-xai-prompt-",
  },
];

export const PATH_RULES: readonly PathRule[] = [
  {
    id: "lint-plugin-dir",
    category: "tooling",
    find: /^oxlint-plugin-t3code\//g,
    replace: "oxlint-plugin-goat/",
  },
  ...IDENTIFIERS.map(([from, to]): PathRule => ({
    id: `identifier:${to}`,
    category: "identifiers",
    // Only the file name, never a directory such as a fixture path.
    find: new RegExp(`(?<=(?:^|/)[^/]*)${from}(?=[^/]*$)`, "g"),
    replace: to,
    scope: outsideMarketingSchema,
  })),
];

/** T3 spellings that stay, each with the reason. Plan decisions D7, D12, D13, D16, D17. */
export const KEEP_RULES: readonly KeepRule[] = [
  {
    id: "legacy-test-inputs",
    pattern:
      /(?:[Tt]3(?:CODE|_CODE)?_[A-Za-z0-9_]+|t3code[:.][A-Za-z0-9_:.-]+|\.t3(?:code)?\b|t3\.json|t3-(?:thread|context|citation):\/\/|t3Home|t3McpApp|__t3McpAppReceive|t3SessionLoadReady|\/\.well-known\/t3\/|t3-context-fragment|t3-desktop-bootstrap:|urn:t3:params:oauth:token-type:environment-bootstrap|refs\/t3(?:code)?\/[^\s"'`]+|t3\/[A-Za-z0-9_/-]+|t3-(?:chat|code)\b)/g,
    scope: isTest,
    reason:
      "Tests deliberately exercise legacy storage, env, homes and peer contracts (D5–D17); expectations must stay legacy.",
  },
  {
    id: "test-repository-names",
    pattern:
      /(?:t3tools\/t3code|(?:pingdotgg|octocat)\/t3code|(?:\/work|\/workspace|\/repo|\/home\/replay-user)\/t3code)\b/g,
    scope: isTest,
    reason: "Fixture repository names and URLs are test input, not GOAT-owned product names.",
  },
  {
    id: "shipped-native-binaries",
    pattern: /t3-(?:resource-monitor|browser-secret|hyprland-snap-shot|kde-snap-shot)/g,
    reason:
      "Installed native executable names require coordinated packaging and upgrade discovery (D16).",
  },
  {
    id: "desktop-runtime-identities",
    pattern: /\bt3code(?:-dev)?\b|--t3code-(?:dev-root|preview-passkey-bridge)/g,
    scope: (path) =>
      /(?:ElectronProtocol|DesktopEarlyElectronStartup|DesktopEnvironment|DesktopLegacyLocalStorage|compileCache|GuestProtocol|electron-launcher|dev-electron)\./.test(
        path,
      ),
    reason:
      "Electron origins, WM class, compile cache, V1 profiles and bridge arguments remain compatible (D13).",
  },
  {
    id: "observability-services",
    pattern: /t3code-(?:desktop|server)|t3-server|(?<="service.namespace": ")t3code/g,
    reason:
      "Operator dashboard service names remain stable; coordinate an observability follow-up.",
  },
  {
    id: "legacy-profile-storage",
    pattern: /t3code:[a-z0-9:-]+|t3\.backgroundActivity\.clientId/g,
    scope: (path) => path === "apps/desktop/src/legacyLocalStorageMerge.ts",
    reason: "V1 profile merge must read the exact persisted upstream keys (D10/D13).",
  },

  {
    id: "attribution",
    pattern: /pingdotgg\/t3code|t3\.codes|T3 Code|T3 Connect|T3 Chat|t3\.chat/g,
    reason: "Upstream attribution, the T3 Connect service and product names (prose is T1).",
  },
  {
    id: "relay-wire",
    pattern: /x-t3-relay-[a-z-]+|x-t3-hook-outcome|t3-connect|t3_relay/g,
    reason: "T3 Connect relay protocol, owned by the upstream relay.",
  },
  {
    id: "relay-env",
    pattern:
      /\b(?:VITE_)?T3CODE_(?:CLERK_[A-Z_]+|RELAY_URL|HOSTED_APP_URL|RELAY_CLIENT_CONFIG_ENV|WEB_(?:ROUTER_URL|LATEST_DOMAIN|NIGHTLY_DOMAIN)|(?:MOBILE|RELAY_CLIENT)_OTLP_TRACES_[A-Z]+)\b/g,
    reason: "Generated by the upstream relay's env export (D7).",
  },
  {
    id: "terminal-magic",
    pattern: /T3VT/g,
    reason: "Binary snapshot magic in the native terminal format.",
  },
  {
    id: "relay-infra",
    pattern: /t3code-relay/g,
    reason: "Upstream T3 Connect relay package and its Effect service tags (plan D14).",
  },
  {
    id: "wire-fields",
    pattern: /\ballT3\b|\bt3CodeVersion\b/g,
    reason:
      "Resource telemetry snapshot field and analytics event property read by other versions (plan D17).",
  },
  {
    id: "legacy-module",
    pattern: /legacyT3Names/g,
    reason: "Name of the compatibility module that holds every legacy spelling (plan D3).",
  },
  {
    id: "repo-project-file",
    pattern: /t3\.json/g,
    reason:
      "This repository's own project file stays t3.json until maintainers run builds that read goat.json (plan D9).",
    scope: (path) => path === "t3.json",
  },
  {
    id: "ssh-runner",
    pattern: /\bT3_[A-Z0-9_]+\b|\bt3_[a-z_]+\b|run-t3\.(?:sh|next)|@@T3_[A-Z0-9_]+@@/g,
    reason:
      "SSH runner script bytes, shell names and file name shared with other client versions (plan D17).",
    scope: (path) =>
      path.startsWith("packages/ssh/") || path.startsWith("apps/server/src/sshRemote/"),
  },
  {
    id: "os-identities",
    pattern:
      /com\.t3tools\.[A-Za-z.]+|\/com\/t3tools\/\w*|t3code\.service|T3SnapShot\w*|T3Code\.(?:Development\.)?SnapShot/g,
    reason: "Installed service, launchd, desktop entry and GNOME extension identities (plan D16).",
  },
  {
    id: "desktop-origin",
    pattern: /\bt3code(?:-dev)?:\/\//g,
    reason: "Desktop renderer origins that key all desktop storage (plan D13).",
  },
  {
    id: "mobile-native",
    pattern:
      /font-t3-[a-z]+|t3-(?:source-text|agent-alert|agent-activity|agent-notifications|composer-editor|markdown-text|native-controls|review-diff|subscription-widget|terminal|widget-expiry)|\bT3(?:SourceText|MenuDismissTouchGate|WorkspaceNavigation|PresentationSources|ComposerEditor|KeyboardCommands|NativeControls|MarkdownText|ReviewDiff|Terminal|SelectableMarkdownText|WidgetExpiry|AgentNotifications|DeviceStream|PreviewStream|Showcase|Demo|Mark|FrostedCutout|LayoutMetrics|NativeFile|NativePresentation|NativeVideo|WorkspaceOrientation|ContextChip)\w*|react-native-screens-[\d.]+-t3\.\d+|t3_terminal\w*|t3(?:agentnotifications|composereditor|markdowntext|nativecontrols|reviewdiff|terminal|widgetexpiry)/g,
    reason:
      "Mobile native module, view and font names; renaming needs a native build host (plan D18).",
  },
  {
    id: "external-identities",
    pattern: /\bt3code_desktop\b|\bt3CodeRange\b/g,
    reason: "Codex clientInfo name and the upstream model manifest key (plan D12).",
  },
];
