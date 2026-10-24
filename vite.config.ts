import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

const DOM_TEST_ENVIRONMENT_ALLOWLIST: Array<string> = [];

// GOAT code that predates upstream's goat/prefer-effect-fn rule (cycle 261021). Convert a file
// to Effect.fn and drop it here; do not add new entries.
const PREFER_EFFECT_FN_BACKLOG: Array<string> = [
  "apps/desktop/src/app/DesktopConnectionCatalogStore.ts",
  "apps/desktop/src/app/DesktopSafeStorageKeyMigration.ts",
  "apps/desktop/src/electron/ElectronSafeStorage.ts",
  "apps/desktop/src/ssh/DesktopSshEnvironment.ts",
  "apps/desktop/src/updates/DesktopBackendActivity.ts",
  "apps/desktop/src/updates/DesktopUpdates.ts",
  "apps/mobile/src/features/notes/rpc/queries.ts",
  "apps/server/scripts/migrate-dev-db.ts",
  "apps/server/src/auth/RpcAuthorization.ts",
  "apps/server/src/channels/ChannelBotHome.ts",
  "apps/server/src/channels/ChannelBotRegistry.ts",
  "apps/server/src/channels/ChannelBotTimeline.ts",
  "apps/server/src/channels/ChannelDeliveryWorker.ts",
  "apps/server/src/channels/ChannelDispatcher.ts",
  "apps/server/src/channels/ChannelGateway.ts",
  "apps/server/src/channels/ChannelIdentityService.ts",
  "apps/server/src/channels/ChannelLedger.ts",
  "apps/server/src/channels/ChannelReceptionService.ts",
  "apps/server/src/channels/ChannelRemoteWorkers.ts",
  "apps/server/src/channels/ChannelRuntime.ts",
  "apps/server/src/channels/ChannelWorkerReports.ts",
  "apps/server/src/channels/channelBotNotes.ts",
  "apps/server/src/channels/channelProjectChoices.ts",
  "apps/server/src/channels/channelWorkerBrief.ts",
  "apps/server/src/channels/channelWorkerObservation.ts",
  "apps/server/src/channels/imessage/ImessageChannelRuntime.ts",
  "apps/server/src/channels/imessage/ImessageChannelSettings.ts",
  "apps/server/src/channels/imessage/imessageSender.ts",
  "apps/server/src/channels/slack/SlackChannelAdapter.ts",
  "apps/server/src/channels/slack/SlackChannelRuntime.ts",
  "apps/server/src/channels/slack/SlackChannelSettings.live.ts",
  "apps/server/src/cli/imessage.ts",
  "apps/server/src/cloud/bootService.ts",
  "apps/server/src/cloud/pinnedRuntime.ts",
  "apps/server/src/cloudAgents/CloudAgentService.ts",
  "apps/server/src/cloudMachines/CloudMachineService.ts",
  "apps/server/src/cloudMachines/sshConfig.ts",
  "apps/server/src/connections/ConnectionCatalogBroker.ts",
  "apps/server/src/fleet/goals/GoalController.ts",
  "apps/server/src/fleet/goals/GoalService.ts",
  "apps/server/src/fleet/goals/GoalStore.ts",
  "apps/server/src/fleet/goals/GoalWorkerRuntime.ts",
  "apps/server/src/fleet/health/FleetHostStates.ts",
  "apps/server/src/fleet/health/Health.ts",
  "apps/server/src/fleet/health/HostHealthMonitor.ts",
  "apps/server/src/fleet/health/Rescheduler.ts",
  "apps/server/src/fleet/resources/Fallback.ts",
  "apps/server/src/fleet/resources/Placement.ts",
  "apps/server/src/handoffs/Handoffs.ts",
  "apps/server/src/hubNodes/HubNodeRepository.ts",
  "apps/server/src/hubProxy/HubProxySessions.ts",
  "apps/server/src/hubProxy/http.ts",
  "apps/server/src/hubProxy/relay.ts",
  "apps/server/src/hubProxy/testFixtures.ts",
  "apps/server/src/linkedHosts/LinkedHosts.ts",
  "apps/server/src/mcp/AcpMcpStdioBridge.ts",
  "apps/server/src/mcp/HostThreadsMcpService.ts",
  "apps/server/src/mcp/LaunchWatchService.ts",
  "apps/server/src/mcp/McpHttpServer.ts",
  "apps/server/src/mcp/McpSessionRegistry.ts",
  "apps/server/src/mcp/OrchestratorMcpService.ts",
  "apps/server/src/mcp/PendingQuestionsMcpService.ts",
  "apps/server/src/mcp/ThreadLaunchMcpService.ts",
  "apps/server/src/mcp/WorktreeInventoryService.ts",
  "apps/server/src/mcp/completionWebhook.ts",
  "apps/server/src/mcp/toolkits/connection/handlers.ts",
  "apps/server/src/mcp/toolkits/fleet/handlers.ts",
  "apps/server/src/mcp/toolkits/fleet/healthHandlers.ts",
  "apps/server/src/mcp/toolkits/memory/handlers.ts",
  "apps/server/src/mcp/toolkits/project/handlers.ts",
  "apps/server/src/mcp/toolkits/provider/handlers.ts",
  "apps/server/src/mcp/toolkits/worktree/handlers.ts",
  "apps/server/src/memory/MemoryGenerationHold.ts",
  "apps/server/src/memory/MemoryHubService.ts",
  "apps/server/src/memory/MemoryQuotaService.ts",
  "apps/server/src/memory/MemoryReportAdapter.ts",
  "apps/server/src/memory/MemoryReportWorker.ts",
  "apps/server/src/memory/MemoryService.ts",
  "apps/server/src/memory/MemorySettingsService.ts",
  "apps/server/src/memory/MemoryStore.ts",
  "apps/server/src/memory/MemorySyncRuntimeLive.ts",
  "apps/server/src/memory/MemorySyncService.ts",
  "apps/server/src/memory/imports/ClaudeMemoryImporter.ts",
  "apps/server/src/memory/imports/CodexMemoryImporter.ts",
  "apps/server/src/memory/imports/MemoryImportFixtures.fixture.ts",
  "apps/server/src/memory/imports/MemoryImportReader.ts",
  "apps/server/src/memory/imports/OmoMemoryImporter.ts",
  "apps/server/src/memory/imports/ProviderMemoryImport.ts",
  "apps/server/src/notes/NoteAutoDone.ts",
  "apps/server/src/notes/NoteResults.ts",
  "apps/server/src/notes/NotesService.ts",
  "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
  "apps/server/src/orchestration-v2/CheckpointService.ts",
  "apps/server/src/orchestration-v2/CloudResultEvents.ts",
  "apps/server/src/orchestration-v2/EventSink.ts",
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "apps/server/src/orchestration-v2/ProjectionStore.ts",
  "apps/server/src/orchestration-v2/ProviderSessionManager.ts",
  "apps/server/src/orchestration-v2/QuestionEscalationService.ts",
  "apps/server/src/orchestration-v2/RunExecutionService.ts",
  "apps/server/src/orchestration-v2/ThreadManagementService.ts",
  "apps/server/src/persistence/Migrations/078_MemoryHubSync.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
  "apps/server/src/provider/CodexHomeRequests.ts",
  "apps/server/src/provider/CodexRouteService.ts",
  "apps/server/src/provider/Drivers/ClaudeAuth.ts",
  "apps/server/src/provider/Drivers/ClaudeCloudDriver.ts",
  "apps/server/src/provider/OpenCodexRoute.ts",
  "apps/server/src/provider/ProviderHostSync.ts",
  "apps/server/src/provider/ProviderOnboarding.ts",
  "apps/server/src/remoteReports/RemoteReportService.ts",
  "apps/server/src/resourceTelemetry/hostCapacity.ts",
  "apps/server/src/runtimeDrain.ts",
  "apps/server/src/serverSettings.ts",
  "apps/server/src/sshRemote/SshDeviceAdd.ts",
  "apps/server/src/sshRemote/SshHostAuthorization.ts",
  "apps/server/src/sshRemote/SshHostSetup.ts",
  "apps/server/src/sshRemote/SshRemoteDispatch.ts",
  "apps/server/src/threadResults/ObservedCheckService.ts",
  "apps/server/src/threadResults/ThreadResultService.ts",
  "apps/server/src/ws.ts",
  "apps/web/src/components/settings/sshPreparation.test-support.ts",
  "apps/web/src/rpc/notes/atoms.ts",
  "packages/client-runtime/src/connection/catalogHost.ts",
  "packages/client-runtime/src/connection/hubProxyDiscovery.ts",
  "packages/client-runtime/src/connection/sshTiming.ts",
  "packages/client-runtime/src/state/sshHost.ts",
  "packages/client-runtime/src/state/sshRuntime.ts",
  "packages/provider-claude-cloud/src/server/adapter.ts",
  "packages/provider-cursor/src/server/CursorAgentSdk.ts",
  "packages/provider-cursor/src/server/adapter.ts",
  "packages/provider-cursor/src/server/cloud/adapter.ts",
  "packages/provider-cursor/src/server/cloud/driver.ts",
  "packages/provider-devin-cloud/src/server/adapter.ts",
  "packages/provider-devin-cloud/src/server/relay.ts",
  "packages/provider-grok/src/server/auth.ts",
  "packages/provider-grok/src/server/driver.ts",
  "packages/provider-opencode/src/server/v2/OpenCode2Server.ts",
  "packages/shared/src/Net.ts",
  "packages/shared/src/goatHome.ts",
  "packages/ssh/src/command.ts",
  "packages/ssh/src/ensureFlight.ts",
  "packages/ssh/src/tunnel.protocol.fixture.ts",
  "packages/ssh/src/tunnel.ts",
  "scripts/dev-runtime-archive.ts",
  "scripts/lib/github-releases.ts",
  "scripts/lib/release-verify.ts",
];

// GOAT web tests that predate upstream's disposable render helper (apps/web/test/render.tsx,
// cycle 261021). Move each to `await using screen = await render(...)` and drop it here.
const DISPOSABLE_RENDER_BACKLOG: Array<string> = [
  "apps/web/src/components/ChatView.ssh.browser.test.tsx",
  "apps/web/src/components/ComposerPromptEditorTiptap.mount.browser.test.tsx",
  "apps/web/src/components/RelativeTimeLabel.browser.test.tsx",
  "apps/web/src/components/ThreadRouteView.browser.test.tsx",
  "apps/web/src/components/auth/ConnectAgentSurface.browser.test.tsx",
  "apps/web/src/components/chat/ChatComposer.ssh.browser.test.tsx",
  "apps/web/src/components/chat/ChatHeader.memory.browser.test.tsx",
  "apps/web/src/components/chat/HandoffCard.browser.test.tsx",
  "apps/web/src/components/chat/V2ItemInspector.browser.test.tsx",
  "apps/web/src/components/chat/useAssistantCitationTarget.browser.test.tsx",
  "apps/web/src/components/decisions/DecisionInbox.browser.test.tsx",
  "apps/web/src/components/decisions/DecisionUserInputForm.browser.test.tsx",
  "apps/web/src/components/decisions/useDecisionInbox.browser.test.tsx",
  "apps/web/src/components/desktop/HubNodesImportCoordinator.browser.test.tsx",
  "apps/web/src/components/files/AttachmentFilePreview.media.browser.test.tsx",
  "apps/web/src/components/files/FileMarkdownSelectionToolbar.browser.test.tsx",
  "apps/web/src/components/files/FilePreviewPanel.browser.test.ts",
  "apps/web/src/components/files/ProjectFilePicker.browser.test.tsx",
  "apps/web/src/components/files/pdf/PdfFilePreview.browser.test.tsx",
  "apps/web/src/components/files/pdf/usePdfDocument.browser.test.tsx",
  "apps/web/src/components/fleet/FleetConsole.browser.test.tsx",
  "apps/web/src/components/fleet/FleetGraph.browser.test.tsx",
  "apps/web/src/components/fleet/FleetThreadList.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotChatView.empty.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotComposer.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotSidebarRow.preview.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotThreadView.visit.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.arrive.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.memory.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.receipt.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.replying.browser.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.time.browser.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotHome.strictMode.browser.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotHome.browser.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotReadMenu.browser.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotSession.browser.test.tsx",
  "apps/web/src/components/media/MediaImagePreview.browser.test.tsx",
  "apps/web/src/components/media/MediaVideoPlayer.browser.test.tsx",
  "apps/web/src/components/preview/PreviewAddressBar.browser.test.tsx",
  "apps/web/src/components/settings/CloudMachinesSettings.browser.test.tsx",
  "apps/web/src/components/settings/CodexHomeRouteSection.browser.test.tsx",
  "apps/web/src/components/settings/ConnectionEnvironmentsSection.browser.test.tsx",
  "apps/web/src/components/settings/ConnectionEnvironmentsSection.u3.browser.test.tsx",
  "apps/web/src/components/settings/GoatBotSettingsPage.browser.test.tsx",
  "apps/web/src/components/settings/HubDeviceCard.browser.test.tsx",
  "apps/web/src/components/settings/MemoryScopePicker.browser.test.tsx",
  "apps/web/src/components/settings/MemoryScopeSettings.subscriptions.browser.test.tsx",
  "apps/web/src/components/settings/MemorySettings.browser.test.tsx",
  "apps/web/src/components/settings/ProviderHostSyncDialog.browser.test.tsx",
  "apps/web/src/components/settings/ProviderWizardAuthenticationStep.browser.test.tsx",
  "apps/web/src/components/settings/RemoteLaunchesSettings.browser.test.tsx",
  "apps/web/src/components/settings/SshRuntimeSettingsRow.browser.test.tsx",
  "apps/web/src/components/settings/settingsDrafts.browser.test.tsx",
  "apps/web/src/components/sidebar/SidebarChrome.browser.test.tsx",
  "apps/web/src/components/sidebar/SidebarEnvironmentConnection.browser.test.tsx",
  "apps/web/src/components/sidebar/useThreadContextDrag.browser.test.ts",
  "apps/web/src/darkModeContrast.browser.test.ts",
  "apps/web/src/fileContextMenu.browser.test.ts",
  "apps/web/src/hooks/settingsPersistence.hook.browser.test.tsx",
  "apps/web/src/hooks/useBrowserHistoryProject.browser.test.tsx",
  "apps/web/src/hooks/useCopyConnectionDiagnostic.browser.test.tsx",
  "apps/web/src/hooks/useSshWorkspaceFetchBack.browser.test.tsx",
  "apps/web/src/notes/NoteConflictDialog.browser.test.tsx",
  "apps/web/src/notes/NoteEditor.browser.test.tsx",
  "apps/web/src/notes/NoteLinkedThread.browser.test.tsx",
];

const TEST_EXCLUDE = [
  "**/.repos/**",
  "**/.t3/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "**/.{idea,git,cache,output,temp}/**",
];

// Directories whose tests belong to a package's own test config. desktop also
// owns the kde-snap-shot tests through its `include`.
const TEST_CONFIG_PACKAGES = [
  "apps/desktop",
  "apps/mobile",
  "apps/server",
  "apps/web",
  "packages/client-runtime",
];

// `vp test run <file>` from the repo root hands each file to its package's
// config. Packages that borrow this config (`--config ../../vite.config.ts`) run
// from their own directory, as CI does, so they keep one plain project.
const isRepoRootTestRun = process.cwd() === import.meta.dirname;

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@goat/client-runtime",
    message:
      "Import from an explicit @goat/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
];

const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "~/components/solar",
  importNames: [
    "GitMergeIcon",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraftIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

/** Web icons are Solar Linear and come from one module, so every surface draws the same set. */
const RESTRICTED_ICON_LIBRARY_IMPORTS = ["lucide-react", "lucide"].map((name) => ({
  name,
  message: "Import icons from ~/components/solar (Solar Linear) so the app keeps one icon set.",
}));

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: TEST_EXCLUDE,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/providerEnv.ts", import.meta.url),
      ),
    ],
    ...(isRepoRootTestRun
      ? {
          projects: [
            ...TEST_CONFIG_PACKAGES,
            {
              extends: true,
              test: {
                name: "root",
                exclude: [
                  ...TEST_EXCLUDE,
                  ...TEST_CONFIG_PACKAGES.map((dir) => `${dir}/**`),
                  "native/kde-snap-shot/**",
                ],
              },
            },
          ],
        }
      : {}),
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      // Macroscope's glob-per-line ignore grammar, not Markdown: formatting
      // it rewrites `*` as `_` and joins lines.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/solar.generated.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/solar.generated.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-goat/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "goat/no-global-process-runtime": "error",
      // Files over 1000 lines, non-null assertions, and casts to any only shrink;
      // oxlint-plugin-goat/code-budgets.json records what exists. docs/operations/code-quality.md
      "goat/code-budget": "error",
      "goat/no-inline-schema-compile": "warn",
      "goat/no-low-value-comments": "error",
      "goat/no-manual-effect-runtime-in-tests": "error",
      "goat/no-native-title-tooltip": "error",
      // Test files only (the rule checks the filename). Becomes an error once existing polls are converted.
      "goat/no-polling-loop-in-tests": "warn",
      "goat/no-raw-mcp-registration": "error",
      "goat/no-real-time-wait-in-tests": "error",
      "goat/no-test-in-loop": "error",
      "goat/no-test-timeout-or-unreasoned-skip": "error",
      "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }],
      "goat/no-unscoped-has": "error",
      "goat/no-wall-clock-in-tests": "error",
      "goat/namespace-node-imports": "error",
      "goat/prefer-catch-tags": "error",
      "goat/prefer-effect-fn": "error",
      "goat/require-centered-scroll-gutter": "error",
      "goat/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: PREFER_EFFECT_FN_BACKLOG,
        rules: { "goat/prefer-effect-fn": "off" },
      },
      {
        files: [
          "**/*.{test,spec,testkit}.{ts,tsx}",
          "**/{test,tests,testkit,testing,fixtures,integration}/**",
          "packages/provider-testing/**",
        ],
        rules: { "goat/prefer-effect-fn": "off" },
      },
      {
        files: ["apps/web/**/*.test.{ts,tsx}"],
        excludeFiles: DISPOSABLE_RENDER_BACKLOG,
        rules: { "goat/require-disposable-render": "error" },
      },
      {
        files: ["apps/web/src/**/*.browser.test.{ts,tsx}"],
        rules: { "goat/no-frame-waits-in-browser-tests": "error" },
      },
      {
        files: ["**/*.browser.test.*"],
        rules: { "goat/no-real-time-wait-in-tests": "off" },
      },
      {
        files: ["apps/**/src/**", "packages/**/src/**"],
        excludeFiles: DOM_TEST_ENVIRONMENT_ALLOWLIST,
        rules: { "goat/no-dom-test-environment": "error" },
      },
      {
        files: ["packages/client-runtime/src/state/**", "apps/{web,mobile,desktop}/src/**"],
        rules: { "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
      },
      {
        files: [
          "packages/client-runtime/src/state/runtime.ts",
          "packages/client-runtime/src/state/vcsAction.ts",
        ],
        rules: {
          "goat/no-rpc-permission-bypass": [
            "error",
            { allowGuardInstallation: true, allowRawClientAccess: false },
          ],
        },
      },
      {
        files: [
          "apps/web/src/components/settings/AuthorizedClientsSettings.tsx",
          "apps/web/src/components/settings/ConnectionsSettings.tsx",
          "apps/mobile/src/features/updates/app-updates.ts",
          "apps/web/src/components/device/DevicePhoneViewport.tsx",
          "apps/web/src/components/device/DeviceDuoViewport.tsx",
        ],
        rules: { "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        files: ["packages/client-runtime/src/connection/outdatedHostUpdate.ts"],
        rules: { "goat/no-rpc-permission-bypass": "off" },
      },
      {
        files: [
          "packages/client-runtime/src/rpc/**",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "goat/no-rpc-permission-bypass": "off" },
      },
      {
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "goat/no-global-process-runtime": "off" },
      },
      {
        // The `t3` npm launcher is published as plain, dependency-free Node.
        files: ["scripts/npm-launcher/**"],
        rules: {
          "goat/no-global-process-runtime": "off",
          "goat/namespace-node-imports": "off",
        },
      },
      {
        files: ["apps/server/src/mcp/McpHttpServer.ts"],
        rules: { "goat/no-raw-mcp-registration": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [
                ...RESTRICTED_IMPORT_PATHS,
                ...RESTRICTED_ICON_LIBRARY_IMPORTS,
                RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS,
              ],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            { paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_ICON_LIBRARY_IMPORTS] },
          ],
        },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: { "goat/no-mobile-uniwind-theme-escape-hatches": "error" },
      },
      {
        files: ["apps/mobile/src/**"],
        excludeFiles: [
          "apps/mobile/src/components/ui/AppSymbol.tsx",
          "apps/mobile/src/components/ui/AppSymbol.ios.tsx",
          "apps/mobile/src/features/pull-requests/pullRequestGlyphs.ts",
        ],
        rules: { "goat/no-mobile-pull-request-glyph-literals": "error" },
      },
      {
        // React commits state set in a raw ResizeObserver callback after the paint, so derived
        // layout lands a frame late. observeResize flushes every observed resize in one render.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "goat/no-raw-resize-observer": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "goat/no-outset-state-indicators": "error" },
      },
      {
        files: ["apps/*/src/**", "packages/*/src/**"],
        excludeFiles: [
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
          "**/testkit/**",
          "**/_generated/**",
          // Real user quotes stay verbatim.
          "apps/marketing/src/lib/tweets.ts",
        ],
        rules: { "goat/no-em-dash-copy": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks (brand logos, the macOS permission panes, Codex's Computer Use
        // mark) must keep their exact colors, so the files that hold them are exempt.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "transition",
                "rounded-[inherit]",
                "gap-[0.33em]",
                "px-[0.5em]",
                "rounded-[0.5em]",
                "text-[0.86em]",
                "rounded-[25%]",
                "text-[length:80cqh]",
                "bg-[Highlight]",
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#263FA9]",
                "fill-[#FEFEFE]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // Every web file must compile under the React Compiler. Its bailout rules are errors here,
        // and manual memoization is redundant. No upstream rule bans useMemo/useCallback, hence
        // goat/no-manual-memo.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "react/exhaustive-effect-dependencies": "error",
          "react/globals": "error",
          "react/hooks": "error",
          "react/immutability": "error",
          // The compiler memoizes context values; this rule would ask for useMemo.
          "react/jsx-no-constructed-context-values": "off",
          "react/memo-dependencies": "error",
          "react/preserve-manual-memoization": "error",
          // oxlint 1.88 treats `new Date()` as impure (oxc#26894) and also flags it inside event
          // handlers (oxc#27309). The compiler we ship (oxc-transform-react) still compiles
          // those files, and reactCompilerCoverage.test.ts fails on real bailouts.
          "react/purity": "warn",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "goat/no-manual-memo": "error",
        },
      },
      {
        // The sign-in masthead is GOAT brand artwork: fixed gradients, not theme surfaces.
        files: ["apps/web/src/components/auth/AuthSurfaceShell.tsx"],
        rules: { "shadcn/no-arbitrary-values": "off" },
      },
      {
        // Shared client code must not call APIs missing from Hermes. Our ESNext
        // TypeScript target accepts them even when they would crash mobile at launch.
        // Tests run on Node and are exempt.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "goat/no-hermes-unsupported-apis": "error" },
      },
      {
        // Mobile is ratcheting toward full React Compiler coverage
        // (apps/mobile/src/reactCompilerCoverage.test.ts). Directives would hide bailouts from it;
        // the manual memo hooks go once the allowlist there is empty.
        files: ["apps/mobile/src/**/*.{ts,tsx}"],
        rules: { "goat/no-manual-memo": ["error", { allowMemoHooks: true }] },
      },
      {
        // The compiler only compiles a use* function that calls a hook; one that calls none is
        // silently left as a plain function, so whatever it returns loses its caching.
        files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "goat/no-hookless-use-function": "error" },
      },
      {
        files: [
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/home/HomeHeader.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
          "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/settings/appearance/components/FontSizeSliderRow.tsx",
          "apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx",
          "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-items.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/T3ComposerEditor.ios.tsx",
          "apps/mobile/src/native/T3ComposerEditor.native.tsx",
          "apps/mobile/src/native/SelectableMarkdownText.tsx",
        ],
        rules: {
          "goat/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
