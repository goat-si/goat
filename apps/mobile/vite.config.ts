import { defineConfig } from "vite-plus";
import "vite-plus/test/config";

const reactTests = [
  "src/components/MediaVideoPlayer.test.tsx",
  "src/features/cloud/CloudAuthProvider.disabled.test.tsx",
  "src/features/cloud/CloudAuthProvider.test.ts",
  "src/features/decisions/useDecisionInbox.test.tsx",
  "src/features/goat-bot/GoatBotBubble.test.tsx",
  "src/features/goat-bot/GoatBotDayStamp.test.tsx",
  "src/features/goat-bot/GoatBotScreen.appearance.test.tsx",
  "src/features/goat-bot/GoatBotScreen.memory.test.tsx",
  "src/features/goat-bot/GoatBotTimelineRow.test.tsx",
  "src/features/goat-bot/MobileGoatBotHomeWorker.test.tsx",
  "src/features/goat-bot/useMobileGoatBotHomeSettings.test.tsx",
  "src/features/goat-bot/useMobileGoatBotSession.test.tsx",
  "src/features/goat-bot/useReplying.test.tsx",
  "src/features/settings/MemorySyncDiagnostics.test.tsx",
  "src/features/settings/SettingsDecisionInboxRouteScreen.test.tsx",
  "src/features/settings/SettingsMemoryRouteScreen.test.tsx",
  "src/features/threads/HumanHandoffCard.test.tsx",
  "src/features/threads/SubagentRow.memory.test.tsx",
  "src/features/threads/ThreadHeader.memory.test.tsx",
  "src/features/threads/ThreadMarkdownImage.test.tsx",
  "src/lib/visible-animations.test.tsx",

  "src/components/ui/Dialog.android.test.tsx",
  "src/features/settings/SettingsHubNodesRouteScreen.test.tsx",
  "src/features/notes/NoteConflictRouteScreen.test.tsx",
  "src/features/notes/NoteLinkedThread.test.tsx",
  "src/features/notes/NoteRouteScreen.test.tsx",
  "src/features/notes/NoteStartWorkRouteScreen.test.tsx",
  "src/features/settings/SettingsServerControlsRouteScreen.test.tsx",
  "src/features/settings/components/BranchNamingSettings.test.tsx",
  "src/native/NativeHeaderToolbar.test.tsx",
  "src/native/useRestingTopOffset.test.tsx",
  "src/state/use-selected-thread-git-actions.test.tsx",
];

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.{ts,tsx,mjs}"],
          exclude: ["**/node_modules/**", ...reactTests],
          setupFiles: [
            "../../packages/shared/src/testing/longTempDir.ts",
            "../../packages/shared/src/testing/providerEnv.ts",
            "../../packages/shared/src/testing/gitEnv.setup.ts",
          ],
          globalSetup: ["../../packages/shared/src/testing/gitConfigGuard.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "react",
          include: reactTests,
          // Native components mock React Native and render through react-dom in these tests.
          environment: "jsdom",
          setupFiles: [
            "../../packages/shared/src/testing/providerEnv.ts",
            "../../packages/shared/src/testing/gitEnv.setup.ts",
          ],
        },
      },
    ],
  },
});
