# devmerge3: origin/dev into T3 catch-up

- Merge: `4ebc82f8c062ba95f4261477187940feab3fda32`; parents `6d566b494b8505501ce7b01f0aa9189a25b467f3` and `40ec5f4a05ce43642f740cac000a8b19b5140176`.
- Branch: `chase/t3-261114-next3-devmerge3`. No integration branch push.
- Node `v26.12.1`, pnpm `12.14.0`; `vp i --frozen-lockfile` succeeded.

## Conflict hunks

- `ConnectAgentSurface.tsx` (1): retained integration pairing-code import and dev `msg`/`useMessages` import.
- `ChatComposer.tsx` (3): retained extracted integration paste shortcut and dev `useMessages`; selected dev's `getCompatibleRuntimeModeOptions` helper (equivalent filtering, with translated message descriptors) while retaining integration's removal of unused local-environment import; removed the conflicting local options constant/function because the shortcut lives in its integration module and dev's helper owns the options.
- `SettingsPanels.tsx` (9): for project grouping, project order, language, time format, unpin, archive, delete and quit reset labels, selected dev's `gt()` labels; for the model selector retained integration's unavailable-model branch and translated the existing mixed-model label using dev `gt("Mixed")`. Condensed two existing single-statement conditions to meet the 1481-line budget without changing behavior.
- `settingsLayout.tsx` (2): retained dev `useMessages()` for the translated unavailable message; retained `gt("override")` and the translated inherited-value tooltip. Removed the duplicate `useGT` import resulting from the merge.
- Nine `translations/*.json` files (3 conflict regions each): integration's 69 keys are a subset of dev's 515; selected dev catalogs byte-for-byte, preserving the union and the dev translations. No differing English source values, so no keys were dropped for stale translations. Chinese dev strings retain 线程 for thread.
- `settingsLayout.browser.test.tsx`: updated Korean expected button name from `언어 기본값으로 재설정` to `언어 기본값 복원` to match the dev-authoritative translation. Before this update the browser test failed showing the latter as the actual accessible name; the updated test passed.

## Shared keys with different localized values

Dev value retained in each case; English had no value differences. Full key list by locale:
- `de`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `a2af8b308068156a`
- `en`: none
- `es`: `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`
- `fr`: `1a6679bbe62703b2`
- `ja`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`
- `ko`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`
- `pt-BR`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`
- `ru`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`
- `zh`: `107c0ba7a6523a28`, `1a6679bbe62703b2`, `21a440a3cf8b9e8d`, `a2af8b308068156a`

## Receipts

- `vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 -- node -v`: `v26.12.1`.
- Server from `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp ... test run src/mcp/McpHttpServer.goatCall.test.ts src/provider/ProviderOnboarding.test.ts`: 2 files, 11 tests passed.
- Web whole files: first batch 24 files / 207 tests passed after the Korean expectation update; second batch 39 files / 551 tests passed. Following the line-budget-only edit, GeneralSettingsPanel, SettingsPanels.restore, SettingsPanels.logic: 3 files / 23 tests passed.
- Client-runtime `threadSnoozed.test.ts` and `customSnooze.test.ts`: 2 files / 50 tests passed.
- `vp run --cache --concurrency-limit 1 --filter @goat/web --filter goat --filter @goat/client-runtime --filter @goat/desktop --filter @goat/mobile typecheck`: 5/5 successful.
- `vp run knip:check:files` and `vp run knip:check:exports`: both exit 0.
- `node scripts/goat-rename.ts --check`: 0 residue lines, 0 files, 0 dropped paths.
- Scratch archive of merge tree, separate git index and symlinked existing node_modules: `node oxlint-plugin-goat/update-code-budgets.ts` exit 0, no over-budget errors; scratch baseline differed because the updater lowered entries. No baseline changes applied to checkout. Commit hook `vp fmt` and `vp lint` passed.
- `vp run --filter goat build`: 2/2 successful (web and server); large-chunk and unresolved optional `x11` external warnings.
- `git diff --check HEAD^1 HEAD`: exit 0. All nine catalogs have 515 matching keys and a simple named ICU-argument set comparison found 0 differences; this is not a full ICU parser validation.
- `vp exec gt generate` in `apps/web`: exit 0 after fixing a duplicate import, but deletes 15 keys per locale. All generated changes discarded; catalogs retained intact. An earlier invocation exited 0 despite reporting that duplicate-import parse error.
- Root `node_modules` existed before this lane and was not removed.
- NOT RUN: `check:changed`, repository-wide suites and dev server, as directed. No separate real-client session was started. Full ICU syntax/semantic validation and a separately discovered complete dependents graph were not run.

### Web test files, first batch

- `apps/web/src/components/BranchToolbar.logic.test.ts`
- `apps/web/src/components/auth/ConnectAgentSurface.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.previewTabMention.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.ssh.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.terminalAnswer.browser.test.tsx`
- `apps/web/src/components/chat/ComposerFooterModeControls.browser.test.tsx`
- `apps/web/src/components/chat/DraftHeroHeadline.browser.test.tsx`
- `apps/web/src/components/settings/AboutVersionSection.browser.test.tsx`
- `apps/web/src/components/settings/AboutVersionTitle.browser.test.tsx`
- `apps/web/src/components/settings/AddProviderInstanceDialog.environment.browser.test.tsx`
- `apps/web/src/components/settings/AgentMemoryLimitSetting.browser.test.tsx`
- `apps/web/src/components/settings/CodexAppServerIsolationSetting.browser.test.tsx`
- `apps/web/src/components/settings/ConnectFlow.browser.test.tsx`
- `apps/web/src/components/settings/GeneralSettingsPanel.browser.test.tsx`
- `apps/web/src/components/settings/ProjectDefaultsSettings.logic.test.ts`
- `apps/web/src/components/settings/SettingInheritance.test.ts`
- `apps/web/src/components/settings/SettingsPanels.logic.test.ts`
- `apps/web/src/components/settings/SettingsPanels.restore.browser.test.tsx`
- `apps/web/src/components/settings/SnoozePresetsSettings.logic.test.ts`
- `apps/web/src/components/settings/settingsLayout.browser.test.tsx`
- `apps/web/src/components/settings/settingsNav.test.ts`
- `apps/web/src/components/settings/settingsSearch.test.ts`
- `apps/web/src/composerPlaceholder.test.ts`
- `apps/web/src/threadNotifications.test.ts`

### Web test files, additional batch

- `apps/web/src/components/BranchHold.test.ts`
- `apps/web/src/components/ChatView.ssh.browser.test.tsx`
- `apps/web/src/components/CommandPalette.logic.test.ts`
- `apps/web/src/components/ThreadNotificationCoordinator.badge.browser.test.ts`
- `apps/web/src/components/chat/TimelineAssistantReply.browser.test.tsx`
- `apps/web/src/components/chat/composerReplyTarget.browser.test.tsx`
- `apps/web/src/components/chat/threadContextDrag.browser.test.tsx`
- `apps/web/src/components/chat/useChatShortcuts.browser.test.tsx`
- `apps/web/src/components/composerFooterLayout.test.ts`
- `apps/web/src/components/pullRequest/PullRequestGuideTab.browser.test.tsx`
- `apps/web/src/components/settings/AddProviderInstanceDialog.presets.test.ts`
- `apps/web/src/components/settings/AgentToolsSettings.browser.test.tsx`
- `apps/web/src/components/settings/AppearanceSettingsPanel.browser.test.tsx`
- `apps/web/src/components/settings/CodexHomeRouteSection.browser.test.tsx`
- `apps/web/src/components/settings/CodexSetupSection.browser.test.tsx`
- `apps/web/src/components/settings/ComputerUsePanel.browser.test.tsx`
- `apps/web/src/components/settings/ComputerUseSettings.browser.test.tsx`
- `apps/web/src/components/settings/DecisionInboxSettings.browser.test.tsx`
- `apps/web/src/components/settings/DesktopWindowMaterialSetting.browser.test.tsx`
- `apps/web/src/components/settings/DisposableMachinesSettings.browser.test.tsx`
- `apps/web/src/components/settings/HubDeviceCard.browser.test.tsx`
- `apps/web/src/components/settings/HubSettings.browser.test.tsx`
- `apps/web/src/components/settings/MemoryDetails.browser.test.tsx`
- `apps/web/src/components/settings/MemorySettings.browser.test.tsx`
- `apps/web/src/components/settings/MemorySitesSettings.browser.test.tsx`
- `apps/web/src/components/settings/PenMachinesSection.browser.test.tsx`
- `apps/web/src/components/settings/ProjectActionsSettings.browser.test.tsx`
- `apps/web/src/components/settings/ProjectSettingsPanel.browser.test.tsx`
- `apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx`
- `apps/web/src/components/settings/SettingsSidebarNav.browser.test.tsx`
- `apps/web/src/components/settings/SourceControlWritingSettings.browser.test.tsx`
- `apps/web/src/components/settings/StorageSettings.browser.test.tsx`
- `apps/web/src/components/settings/TextGeneratorAndUsageSettings.browser.test.tsx`
- `apps/web/src/components/settings/ThemeSettings.browser.test.tsx`
- `apps/web/src/components/settings/TypographySettings.browser.test.tsx`
- `apps/web/src/components/settings/settingsDrafts.browser.test.tsx`
- `apps/web/src/components/settings/settingsScopeNavigation.test.ts`
- `apps/web/src/components/sidebar/useBotThreadKeys.browser.test.tsx`
- `apps/web/src/lib/resourceTelemetryState.browser.test.tsx`
