/**
 * The GOAT rename table. Each phase of the T3 removal adds its rules here;
 * `node scripts/goat-rename.ts --list` prints them. Order matters: longer,
 * more specific spellings come before shorter ones.
 *
 * Plan and reasons: devlog/_plan/261013_remove-t3-internals/000_plan.md.
 */
import { RESIDUE_KEEP_RULES } from "./rules-residue.ts";
import { EXTERNAL_KEEP_RULES } from "./rules-external.ts";
import { INTERNAL_KEEP_RULES, INTERNAL_TEXT_RULES } from "./rules-internal.ts";
import { isTest } from "./paths.ts";
export { isTest } from "./paths.ts";

import { WIRE_TEXT_RULES, WIRE_KEEP_RULES } from "./rules-wire.ts";
import type { DropRule, KeepRule, PathRule, TextRule } from "./engine.ts";
import { VISIBLE_KEEP_RULES, VISIBLE_TEXT_RULES } from "./rules-visible.ts";
import { LEFTOVER_PATH_RULES, LEFTOVER_TEXT_RULES } from "./rules-leftovers.ts";
import { META_KEEP_RULES, META_TEXT_RULES, TITLE_TEXT_RULES } from "./rules-meta.ts";
import { OWNER_KEEP_RULES, OWNER_TEXT_RULES } from "./rules-owner.ts";
import {
  CONNECT_CONTRAST_RULES,
  RELAY_KEEP_RULES,
  RELAY_PATH_RULES,
  RELAY_TEXT_RULES,
} from "./rules-relay.ts";
import { SAMPLE_TEXT_RULES } from "./rules-samples.ts";
export { isMovableAsset } from "./rules-leftovers.ts";

/**
 * Files no rule touches and the residue check skips. Upstream-owned files
 * that GOAT does not run stay byte-identical so upstream syncs merge cleanly.
 */
export const isExempt = (path: string): boolean =>
  // Recorded protocols and generated/binary assets are upstream input, not rename output.
  /\.ndjson$|\.(?:png|jpg|jpeg|ico|icns|woff2?|ttf|wasm|pdf|svg)$/.test(path) ||
  path === "pnpm-lock.yaml" ||
  // Marketing copy and its i18n stay upstream-shaped; the schema route and its docs are GOAT's.
  (path.startsWith("apps/marketing/") &&
    !path.startsWith("apps/marketing/src/pages/schema/") &&
    path !== "apps/marketing/README.md" &&
    path !== "apps/marketing/DESIGN.md") ||
  // The relay is GOAT Connect's; its migrations are snapshots upstream also edits.
  (path.startsWith("infra/") &&
    (!path.startsWith("infra/relay/") || path.startsWith("infra/relay/migrations/"))) ||
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
 * D17), `t3Home` (desktop bootstrap
 * key, D17), `t3CodeRange` (upstream model manifest key) and mobile native
 * modules (wp8).
 */
const IDENTIFIERS: ReadonlyArray<readonly [from: string, to: string]> = [
  // Local names around GOAT Connect. The persisted route kind "t3-connect" stays (legacyT3Names.ts).
  ["T3Connect", "GoatConnect"],
  ["T3CodeRelay", "GoatRelay"],
  ["t3MintCredential", "goatMintCredential"],
  ["t3Connect", "goatConnect"],
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

/**
 * `T3CODE_X`, `T3_CODE_X` and `T3_X` become `GOAT_X` (plan D5). A name may follow a
 * `\\n` escape inside a string. Runner shell names and relay keys stay.
 */
export const ENV_NAME = new RegExp(
  String.raw`(?:(?<=\\n)|(?<![A-Za-z0-9_]))(?!T3_(?:${SSH_RUNNER_SHELL_NAMES})\b)(VITE_|EXPO_PUBLIC_)?T3(?:CODE|_CODE)?_([A-Z0-9_]*[A-Z0-9])\b`,
  "g",
);

/**
 * The SSH runner and the fixtures that pin its bytes (plan D17). The ownership scripts are
 * uploaded byte for byte and hand T3CODE_ names to older runtimes, so a marker would change them.
 */
const outsideSshRunner = (path: string) =>
  !/^packages\/ssh\/src\/(tunnel[^/]*|runtimeOwnershipScripts\.ts|fixtures\/.*)$/.test(path);

/** Lint rule ids are listed so that unrelated `t3code/...` paths and branch names stay. */
const LINT_RULE_IDS =
  "namespace-node-imports|no-dom-test-environment|no-em-dash-copy|no-frame-waits-in-browser-tests|no-global-process-runtime|no-hermes-unsupported-apis|no-hookless-use-function|no-inline-schema-compile|no-low-value-comments|no-manual-effect-runtime-in-tests|no-manual-memo|no-mobile-pull-request-glyph-literals|no-mobile-uniwind-theme-escape-hatches|no-native-title-tooltip|no-outset-state-indicators|no-polling-loop-in-tests|no-raw-mcp-registration|no-raw-resize-observer|no-real-time-wait-in-tests|no-rpc-permission-bypass|no-test-in-loop|no-test-timeout-or-unreasoned-skip|no-unscoped-has|no-wall-clock-in-tests|prefer-catch-tags|prefer-effect-fn|require-centered-scroll-gutter|require-disposable-render|require-suppression-reason";

export const TEXT_RULES: readonly TextRule[] = [
  ...CONNECT_CONTRAST_RULES,
  ...VISIBLE_TEXT_RULES,
  ...WIRE_TEXT_RULES,
  ...INTERNAL_TEXT_RULES,
  ...RELAY_TEXT_RULES,
  {
    id: "pull-request-context-tag",
    category: "local-names",
    find: /t3\/PullRequestService\/routingCredential/g,
    replace: "goat/PullRequestService/routingCredential",
    scope: (path) => path === "apps/server/src/pullRequest/PullRequestService.ts",
  },
  {
    id: "showcase-temp-prefix",
    category: "fixtures",
    find: /t3-(?=showcase-wake-)/g,
    replace: "goat-",
    scope: (path) => path === "scripts/mobile-showcase.ts",
  },

  {
    id: "local-plugin-names",
    category: "local-names",
    find: /t3code:(?=dev-compression|third-party-licenses)/g,
    replace: "goat:",
    scope: (path) =>
      path === "apps/web/vite.config.ts" || path === "scripts/lib/third-party-licenses.ts",
  },
  {
    id: "favicon-placeholder-origin",
    category: "local-names",
    find: /t3\.invalid/g,
    replace: "goat.invalid",
    scope: (path) => path === "packages/shared/src/projectFavicon.ts",
  },
  {
    id: "runtime-temporary-names",
    category: "fixtures",
    find: /t3(?:code)?-(?=pr-body-|checkpoint-index-|kde-activate-|background-suite-)|(?<=prefix: [`"'])t3code-(?=\$)/g,
    replace: "goat-",
    scope: (path) =>
      /(?:GitManager|GitVcsDriver|KdeSnapShot|verify-background-live|CodexTextGeneration)\.ts$/.test(
        path,
      ),
  },

  {
    id: "migration-test-locals",
    category: "local-names",
    find: /\bt3Dir\b/g,
    replace: "legacyDir",
    scope: (path) => path === "apps/server/scripts/migrate-dev-db.test.ts",
  },
  {
    id: "otel-local-config",
    category: "local-names",
    find: /\bt3\b/g,
    replace: "goat",
    scope: (path) => path === "packages/shared/src/otelEnvironment.ts",
  },
  {
    id: "server-local-symbols",
    category: "local-names",
    find: /(?<=CLAUDE_(?:READ_ONLY_)?)T3_MCP/g,
    replace: "GOAT_MCP",
    scope: (path) => path.startsWith("apps/server/"),
  },
  {
    id: "server-guest-globals",
    category: "local-names",
    find: /(?<=__)t3(?=Recorder|PreviewClipboard|c\b)/g,
    replace: "goat",
    scope: (path) => path.startsWith("apps/server/"),
  },
  {
    id: "installer-local-home",
    category: "local-names",
    find: /\bt3_home\b/g,
    replace: "goat_home",
    scope: (path) => path === "scripts/install.sh",
  },
  {
    id: "contracts-service-tag",
    category: "local-names",
    find: /t3\/contracts\/RpcScopeAuthorization/g,
    replace: "goat/contracts/RpcScopeAuthorization",
    scope: (path) => path === "packages/contracts/src/rpc.ts",
  },
  {
    id: "web-local-dom-names",
    category: "dom",
    find: /t3-(?=assistant-citation|thread-find|tree-icon-|tree-spin|mobile-composer|mobile-draft-headline|thread-context-drop)/g,
    replace: "goat-",
    scope: (path) => path.startsWith("apps/web/"),
  },
  {
    id: "web-sprite-id",
    category: "dom",
    find: /t3code-pierre-file-icon-sprite/g,
    replace: "goat-pierre-file-icon-sprite",
    scope: (path) => path.startsWith("apps/web/"),
  },
  {
    id: "markdown-parser-prefix",
    category: "local-names",
    find: /t3-markdown-inline-prefix:/g,
    replace: "goat-markdown-inline-prefix:",
    scope: (path) =>
      path === "packages/shared/src/markdownListIndentation.ts" ||
      path === "apps/web/src/markdown-incremental.test.tsx",
  },
  {
    id: "web-local-events",
    category: "dom",
    find: /t3:(?=thread-find-open|paste-as-text)/g,
    replace: "goat:",
    scope: (path) => path.startsWith("apps/web/"),
  },

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
    find: /(?<=(?:prefix\s*[:=]\s*|mkdtemp(?:Sync)?\(.*|makeTempDir\(.*)["'`]\.?)t3(?:code)?-(?=[a-z$])|(?<=["'`])t3(?:code)?-(?=(?:git-manager|codex-home|claude-home|workspace|codex-shared|codex-shadow-root)-)|(?<=prefix\s*[:=]\s*["'`])t3-(?=\$\{input\.kind\}-vcs-contract-)/g,
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
  // Installed and operator-facing identities (#111, #112). Their migrations are
  // hand code that reads the legacy spellings from legacyT3Names.ts.
  {
    id: "native-helper-binaries",
    category: "identities",
    find: /\bt3(?=-(?:resource-monitor|browser-secret)\b)/g,
    replace: "goat",
  },
  {
    id: "mobile-font-utilities",
    category: "identities",
    find: /(?<=\bfont-)t3(?=-[a-z])/g,
    replace: "goat",
    scope: (path) => path.startsWith("apps/mobile/"),
  },
  {
    id: "otlp-service-identity",
    category: "identities",
    find: /\bt3code(?=-(?:server|desktop|web)\b)|(?<="service\.namespace": "|"stringValue":")t3code(?=")|(?<="service\.runtime": ")t3(?=-(?:server|web)")|(?<=")t3code(?=\.(?:server\.managed_by|client\.surface)")/g,
    replace: "goat",
    scope: (path) =>
      /^(?:apps\/server\/src\/(?:config|persistence\/Sqlite|serverLogger\.test)|apps\/desktop\/src\/app\/DesktopObservability(?:\.test)?|apps\/web\/src\/observability\/clientTracing)\.ts$/.test(
        path,
      ),
  },
  {
    id: "ssh-runtime-span-attributes",
    category: "identities",
    find: /(?<=")t3(?=\.runtime\.)/g,
    replace: "goat",
    scope: (path) => path.startsWith("packages/ssh/"),
  },
  {
    id: "agent-scope-units",
    category: "identities",
    find: /(?<=app-)t3code(?=-agents\.slice)|(?<=`)t3code(?=-\$\{name\})/g,
    replace: "goat",
    scope: (path) => path === "apps/server/src/process/agentScope.ts",
  },
  // Repository hygiene (devlog/_plan/261021_repo_hygiene.md).
  {
    id: "repo-skill-names",
    category: "hygiene",
    find: /\btest-t3-(app|mobile)\b/g,
    replace: "test-goat-$1",
    // Upstream tests use the old skill name as sample data; renaming them only adds merge churn.
    scope: (path) => !isTest(path),
  },
  // Last, so they see text the env, package and identifier rules already renamed.
  ...LEFTOVER_TEXT_RULES,
  ...OWNER_TEXT_RULES,
  ...META_TEXT_RULES,
  ...TITLE_TEXT_RULES,
  ...SAMPLE_TEXT_RULES,
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
  {
    id: "repo-skill-names",
    category: "hygiene",
    find: /^\.agents\/skills\/test-t3-(app|mobile)\//g,
    replace: ".agents/skills/test-goat-$1/",
  },
  ...LEFTOVER_PATH_RULES,
  ...RELAY_PATH_RULES,
  {
    // Builds since v0.1.1 read goat.json first and fall back to t3.json (plan 261013 D9).
    id: "repo-project-file",
    category: "hygiene",
    find: /^t3\.json$/g,
    replace: "goat.json",
  },
];

/** Upstream paths GOAT drops. Reasons: devlog/_plan/261021_repo_hygiene.md. */
export const DROP_RULES: readonly DropRule[] = [
  {
    id: "vercel-configs",
    category: "hygiene",
    find: /^apps\/(?:web|marketing)\/vercel\.ts$/,
    reason: "GOAT deploys no hosted web app and publishes marketing to GitHub Pages.",
  },
  {
    id: "cursor-rules",
    category: "hygiene",
    find: /^\.cursor\//,
    reason:
      "Cursor reads AGENTS.md; the Cursor Cloud notes describe upstream's VM and contradict AGENTS.md.",
  },
];

/** T3 spellings that stay, each with the reason. Plan decisions D7, D12, D13, D16, D17. */
export const KEEP_RULES: readonly KeepRule[] = [
  ...META_KEEP_RULES,
  ...RELAY_KEEP_RULES,
  ...EXTERNAL_KEEP_RULES,
  ...OWNER_KEEP_RULES,
  ...RESIDUE_KEEP_RULES,
  ...VISIBLE_KEEP_RULES,
  ...WIRE_KEEP_RULES,
  ...INTERNAL_KEEP_RULES,
  {
    id: "legacy-server-error-reader",
    pattern: /T3 server WebSocket/g,
    scope: (path) => path === "packages/client-runtime/src/errors/transport.ts",
    reason:
      "Compatibility matcher recognizes error messages emitted by older remote servers (D17).",
  },

  {
    id: "upstream-license-files",
    pattern: /LICENSE-T3CODE\.txt/g,
    reason: "The upstream MIT license filename is shipped attribution (D12).",
  },
  {
    id: "packaged-capture-binary",
    pattern: /t3-\$\{input\.backend\}-snap-shot/g,
    scope: (path) => path === "scripts/build-desktop-artifact.ts",
    reason: "Packaging must name the existing shipped native capture binary (D16).",
  },
  {
    id: "shared-ssh-helpers",
    pattern: /t3code-ssh-askpass|(?<=DISPLAY: ")t3code/g,
    scope: (path) => path === "packages/ssh/src/auth.ts",
    reason:
      "The persisted askpass directory is shared with older builds; preserve the SSH child environment contract (D17).",
  },
  {
    id: "persisted-showcase-simulators",
    pattern: /T3 Showcase/g,
    scope: (path) => path === "scripts/mobile-showcase.config.ts",
    reason:
      "Named CoreSimulator devices persist on native build hosts; changing them creates duplicate devices (D18).",
  },

  {
    id: "credential-owner",
    pattern: /(?<=["'])t3(?=["'])/g,
    scope: (path) =>
      /(?:ProviderCredentialStore|ProviderHost|providerSetup|TestProviderHost|packages\/provider-(?:core|cursor)\/src\/server\/auth)\./.test(
        path,
      ) || /packages\/provider-(?:core|cursor)\/src\/server\/auth\.ts$/.test(path),
    reason:
      "Credential owner discriminant is persisted in provider setup/auth records and read by existing clients (D17).",
  },
  {
    id: "retained-tool-history",
    pattern: /t3_[a-z_]+|t3\[-_ \]\?code|t3-code|t3code/g,
    scope: (path) => path === "packages/shared/src/goatMcpToolPresentation.ts",
    reason: "Presentation aliases recognize tool names in existing thread history (D12).",
  },
  {
    id: "message-attribution",
    pattern: /t3code/g,
    scope: (path) =>
      path === "packages/client-runtime/src/userMessage.ts" || path.endsWith("ThreadFeed.tsx"),
    reason:
      "Conversation attribution discriminant is persisted and shared with independently versioned clients (D17).",
  },
  {
    id: "electron-schemes",
    pattern: /t3code/g,
    scope: (path) =>
      /(?:codexAuthHandoff|promptLinks|providerAuthReturnUrl|features\/connection\/pairing)\./.test(
        path,
      ),
    reason:
      "OAuth/deep links and persisted Electron origins remain usable across installed app versions (D13).",
  },
  {
    id: "upstream-mobile-build-cache",
    pattern: /t3code|t3_kind/g,
    scope: (path) =>
      path.startsWith("apps/mobile/modules/") || path.endsWith("showcaseAgentActivity.ts"),
    reason:
      "Upstream native build caches and OS notification payload keys are retained with native modules (D18).",
  },
  {
    id: "showcase-inputs",
    pattern: /t3code/g,
    scope: (path) => path.endsWith("showcasePendingTasks.ts"),
    reason: "Showcase project IDs must match the seeded sample repository fixtures.",
  },
  {
    id: "native-capture-fixtures",
    pattern: /[Tt]3(?:-snap-shot)?/g,
    scope: (path) =>
      path === "native/hyprland-snap-shot/src/ipc.rs" ||
      path === "native/hyprland-snap-shot/src/feedback.rs",
    reason:
      "Installed capture helper surface identifiers and its embedded test window identities stay with the native binary (D16).",
  },
  {
    id: "provider-replay-contracts",
    pattern: /t3\.|t3-antigravity-browser-preflight/g,
    scope: (path) =>
      path === "packages/provider-pi/src/server/adapter.ts" ||
      path === "packages/provider-testing/src/replayWorkspace.ts" ||
      path.endsWith("antigravityAuthSupport.ts"),
    reason:
      "Retained Pi extension event filtering, replay commit provenance and provider preflight URL are provider protocol/fixture inputs (D12/D17).",
  },
  {
    id: "upstream-test-release-urls",
    pattern: /t3-code-v2-beta/g,
    scope: (path) => path.endsWith("NightlyMobileBeta.tsx"),
    reason: "Upstream Play beta group URL is an external service identity (D12).",
  },

  {
    id: "encoded-payloads",
    pattern: /[A-Za-z0-9+/]{100,}={0,2}/g,
    reason: "Embedded base64 image/archive bytes are generated payloads, not branding tokens.",
  },
  {
    id: "provider-and-mcp-peers",
    pattern:
      /t3-code(?:-[a-z-]+)?|t3_code|t3code(?=["'])|t3-host-|t3\.(?:ui_request_expired|settle_probe|flush_extension_errors|rollback_barrier)|t3-(?=\$\{nextRequestId)/g,
    scope: (path) =>
      path.startsWith("packages/provider-") ||
      path.startsWith("packages/effect-acp/") ||
      /(?:ProviderCredentialStore|McpApp|mcpApps\/host|ProviderHost|providerSetup|MessagesTimeline|threadActivity|thread-work-log|goatMcpToolPresentation)/.test(
        path,
      ),
    reason:
      "Provider identities, credential ownership, persisted tool presentation and MCP/Pi extension messages are consumed by retained providers or embedded peers (D12/D17).",
  },
  {
    id: "installed-native-and-helper-state",
    pattern:
      /t3-chrome-headless-shell|t3-snap-shot-|t3_capture_|t3_\$\{|t3-(?:capture|permission-check|kde-bus)|t3_chats|t3_pull_requests|t3-preview-|t3-context-content|t3-showcase-(?:scene|ready)|t3_subscription_widget_enabled/g,
    scope: (path) =>
      path.startsWith("native/") ||
      path.startsWith("apps/mobile/modules/") ||
      path.startsWith("apps/desktop/src/snapShot/") ||
      path === "apps/server/src/preview/PreviewBrowserHost.ts" ||
      path === "scripts/mobile-showcase.ts",
    reason:
      "Installed capture shortcut/config identities, AppArmor profile and native helper resources/protocol files require coordinated migration/rebuild (D16/D18).",
  },
  {
    id: "retained-browser-and-device-state",
    pattern:
      /t3-\$\{(?:hash|generation)|t3-page\.localhost|t3-html-render-overflow|t3:(?="navigated)|t3-upload-|t3-pierre-(?:dark|light)/g,
    scope: (path) =>
      path.startsWith("apps/mobile/") ||
      path === "apps/server/src/device/AgentDeviceTarget.ts" ||
      path === "apps/server/src/preview/ServerBrowserPage.ts" ||
      path === "apps/server/src/htmlRender/headlessChrome.ts",
    reason:
      "Native caches and embedded browser/device handles can outlive this build or be read by another client; preserve origin/handle contracts (D17/D18).",
  },
  {
    id: "legacy-safety-and-peer-protocol",
    pattern:
      /urn:t3:params:oauth:token-type:environment-bootstrap|\/\.well-known\/t3\/|T3B|run-t3\.retained|t3_write_pty|t3-acp-\(\\d\+\)-/g,
    reason:
      "OAuth and SSH peer output, retained runner files, bundled Ghostty wasm ABI and stale cgroup discovery stay compatible (D17).",
  },
  {
    id: "legacy-artifacts",
    pattern: /t3-link-|t3code\/custom-io-ordered-feed|t3-agent/g,
    scope: (path) =>
      /(?:GitVcsDriver|build-cli-archive|htmlRender|third-party-licenses|AgentScope)\./.test(path),
    reason:
      "Checkpoint provenance, archive manifest identity, stored HTML and vendored upstream source references preserve historical artifacts (D12/D17).",
  },
  {
    id: "upstream-mobile-attribution",
    pattern: /T3 Tools|t3tools\.com|\bT3Code\b|t3code: repair cached CocoaPods/g,
    scope: (path) => path.startsWith("apps/mobile/"),
    reason:
      "Upstream native attribution and build host/cache markers are deferred with native modules (D18).",
  },
  {
    id: "showcase-and-release-fixtures",
    pattern: /[A-Za-z0-9_]*[Tt]3[A-Za-z0-9_]*(?:[-.:/][A-Za-z0-9_-]+)*/g,
    scope: (path) =>
      /(?:mobile-showcase-environment|release-smoke|acp-mock-agent|codexReplayRecordingRecords)\.ts$/.test(
        path,
      ),
    reason:
      "Historical release and replay/sample repository inputs are fixtures, not product names.",
  },
  {
    id: "skill-name-fixtures",
    pattern: /test-t3-(?:app|mobile)/g,
    scope: isTest,
    reason: "Upstream tests use the old repository skill name as sample data.",
  },
  {
    id: "peer-wire-and-history",
    pattern:
      /t3McpApp|__t3McpAppReceive|t3Home|t3SessionLoadReady|t3-(?:thread|context|citation):\/\/|data-t3-context-fragment|application\/x-t3code-[a-z-]+|t3code_no_provider|unknown-t3|t3_code_(?:orchestration|runtime|tools|instructions|orchestration_instructions)|t3_thread_read|__t3DesktopPreviewRecordingCapture/g,
    reason:
      "Bootstrap, stored conversation/credential attribution, drag/clipboard and embedded peer payload spellings remain readable across builds (D12/D17).",
  },
  {
    // Frozen through the first stable release (ADR-0014, "Frozen legacy identities"):
    // t3code.desktop and the deb package `t3code`. Pinned launchers and URL handlers follow the
    // entry name, and a renamed package installs beside the old one instead of upgrading it.
    id: "installed-desktop-metadata",
    pattern: /LICENSE-T3CODE\.txt|t3code\.desktop|X-T3Code-Capture-Helper|\bt3code\b/g,
    scope: (path) =>
      /(?:build-desktop-artifact|DesktopAppIdentity|Passkeys|DesktopAssets|brand-assets|release-|metainfo|GnomeCaptureSetup|HyprlandSnapShot|KdeSnapShot|bootService|agentScope|mobile-native-client|build-libghostty-wasm)\./.test(
        path,
      ) || path.startsWith(".github/workflows/"),
    reason:
      "Packaged build metadata, asset references and installed OS/cache identities are consumed by installed helpers and older builds (D13/D16).",
  },
  {
    id: "upstream-provider-contracts",
    pattern:
      /t3-code(?:-[a-z-]+)?|t3-pi-mcp|t3-acp-cli-[a-z-]+|t3_code|_t3_unknown|_t3\/session-mode|\$t3:jsonrpc:|msg_t3_(?:turn|steer)_|t3-term-|t3-acp-(?:cgroup-wrapper|\\?d|\$)|t3-\d+|t3-tools/g,
    scope: (path) =>
      path.startsWith("packages/provider-") ||
      path.startsWith("packages/effect-acp/") ||
      /(?:Antigravity|AcpMcpStdioBridge|PiAdapterV2|goatMcpToolPresentation|mcpApps\/host)/.test(
        path,
      ),
    reason:
      "Provider client identity, session/config ids and replay normalization are read by independently versioned provider runtimes and retained sessions (D12/D17).",
  },
  {
    id: "persisted-files-and-refs",
    pattern:
      /\.t3(?:code)?\b|t3-(?:composer-attachments|composer-paste|favicon-thumbnail|acp-registry-icons-v1)|t3\.pullRequests\.[a-z]+|refs\/t3\/review-guide|t3code\/pr-|t3-runtime-archive|t3-theme/g,
    reason:
      "Existing homes, attachment/cache files, review refs, pull-request preferences and saved HTML artifacts must survive upgrades (D8/D10/D17).",
  },
  {
    id: "operator-span-names",
    pattern: /t3\.runtime\.[A-Za-z.]+/g,
    scope: (path) => path.startsWith("packages/ssh/"),
    reason:
      "SSH acquisition observability names feed operator dashboards; coordinate with service-name follow-up.",
  },
  {
    id: "legacy-cli-package",
    pattern:
      /@t3code\/t3-|t3code\/t3|t3code\\\/t3|(?<=["'])t3(?=["'])|(?<=`|npx )t3(?=`|@)|(?<=bin\/)t3(?=\.[cm]?js)/g,
    scope: (path) =>
      /(?:invocation|build-npm-launcher|npm-launcher\/|package\.json|install\.|npmRelease|versionSkew)/.test(
        path,
      ),
    reason: "Legacy npm package and CLI alias remain installable and discoverable (D4/D12).",
  },

  {
    // Source copy is the recurrence gate; fixtures follow their source (#98/#99, R7 PR4).
    id: "test-fixture-values",
    pattern:
      /\b(?:T3[A-Za-z0-9_]*|t3reviewdiff|[Tt]3(?:code|Code|Tools|tools|dotgg)?(?:[-.:/][A-Za-z0-9_-]+)*|T3B|_t3_unknown|__t3Xss|t3code_codex_(?:missing|first|second)_|t3coderelay[-A-Za-z0-9]*|t3Source|fromT3|missingT3|t3chat-[A-Za-z0-9-]+|host3|project3|bt3kw2qpn)\b|mcp__t3(?:code|-code)__|(?:[Tt]3)_|(?<=\.mount_)[Tt]3[A-Za-z0-9]*|\burn%3At3%3A/g,
    scope: isTest,
    reason:
      "Opaque test fixture paths, mock process/app/repository identities and historical release URLs; these are input samples, not product identifiers.",
  },
  {
    id: "legacy-project-source",
    pattern: /t3\.json/g,
    reason:
      "Legacy project filename and source labels remain accepted and emitted for peers and existing checkouts (D9/D17).",
  },
  {
    id: "false-positive-types",
    pattern: /\b(?:Object3D|Digit3|u?int3(?:2|64)?(?:_t)?)\b/g,
    reason: "Three.js, keyboard and numeric type spellings are unrelated to T3 branding.",
  },
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
    pattern: /t3-(?:hyprland-snap-shot|kde-snap-shot)/g,
    reason:
      "Installed native executable names require coordinated packaging and upgrade discovery (D16).",
  },
  {
    // Frozen (ADR-0014): the Linux WM class `t3code`/`t3code-dev`. Docks match windows to the
    // desktop entry by it, so a rename splits running windows from users' pinned launchers.
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
    id: "legacy-profile-storage",
    pattern: /t3code:[a-z0-9:-]+|t3\.backgroundActivity\.clientId/g,
    scope: (path) => path === "apps/desktop/src/legacyLocalStorageMerge.ts",
    reason: "V1 profile merge must read the exact persisted upstream keys (D10/D13).",
  },

  {
    id: "terminal-magic",
    pattern: /T3VT/g,
    reason: "Binary snapshot magic in the native terminal format.",
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
    // Frozen (ADR-0014): `run-t3.sh`. Every client version finds the remote runner by this name.
    id: "ssh-runner",
    pattern: /\bT3(?:CODE)?_[A-Z0-9_]+\b|\bt3_[a-z_]+\b|run-t3\.(?:sh|next)|@@T3_[A-Z0-9_]+@@/g,
    reason:
      "SSH runner script bytes, shell names and file name shared with other client versions (plan D17).",
    scope: (path) =>
      path.startsWith("packages/ssh/") || path.startsWith("apps/server/src/sshRemote/"),
  },
  {
    // Frozen (ADR-0014): the GNOME capture D-Bus names (com.t3tools.T3Code.SnapShot,
    // /com/t3tools/SnapShot) and the KDE helper com.t3tools.T3Code.KdeCapture. On Wayland a renamed
    // extension loads only after the user signs in again, so capture would stop working until then.
    id: "os-identities",
    pattern:
      /com\.t3tools(?:\.[A-Za-z0-9.]+)?|\/com\/t3tools\/\w*|t3code\.service|T3SnapShot\w*|T3Code\.(?:Development\.)?SnapShot/g,
    reason: "Installed service, launchd, desktop entry and GNOME extension identities (plan D16).",
  },
  {
    id: "desktop-origin",
    pattern: /\bt3code(?:-dev)?:\/\//g,
    reason: "Desktop renderer origins that key all desktop storage (plan D13).",
  },
  {
    id: "external-identities",
    pattern: /\bt3code_desktop\b|\bt3CodeRange\b/g,
    reason: "Codex clientInfo name and the upstream model manifest key (plan D12).",
  },
];
