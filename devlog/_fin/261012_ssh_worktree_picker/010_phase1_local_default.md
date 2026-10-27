# 010 PR1: Local default, plain workspace labels, retire Previous worktree

- Depends on: [000_plan.md](./000_plan.md), authoritative D-u1–D-u7, A1/A4/A14 dispositions and M1–M6.
- Implementation branch: `goat/ws-picker-1-local-default`; PR base: `dev`.
- Archetype/trigger: wp1 of the satisfy-spec stack authorized in 000; this document is the delegated docs-only implementation design, not an FSM transition or implementation receipt.
- Goal: every deliberate new-thread request resolves workspace defaults afresh; users can always read the workspace mode; Previous worktree and its shortcut disappear without obsolete-config warnings.
- Non-goals: SSH destination fields, submenu, synchronization, fetch-back, RPC additions, providers, mobile SSH UI, transport changes and changes to generic in-place draft editing.
- Verifier: focused suites and affected-package typechecks/lint below, then parent-owned exact-head goat-ci and review. Existing-tree results are baseline feasibility proof only.
- Stop: deliver this design; parent owns implementation, evidence capture, PRs and landing. Terminal results for this delegation: written design or an explicit source/input gap. Escalation: report contradictions under Plan conflicts; do not reopen decisions.
- Artifact: this file; supplied consultation artifacts remain in `/tmp/ssh-wt`.

A new-thread request must not revive an empty draft's old worktree selection. Resolve the target project's defaults (project override → environment → t3.json → built-in Local), reset branch/path/origin when no workspace options were explicitly supplied, and use that same boundary after background send. Invested drafts remain available with their selections. Workspace text is Local, New worktree, or Worktree, with the owning environment appended only when it is not this device. Machine and Auto balance names remain in the machine icon tooltip and Run on menu.

## Scope IN / OUT

IN: narrow combined composer selector; wide `BranchToolbarEnvModeSelector`; shared thread-panel run context; settings default and inheritance labels; mobile workspace labels and accessibility copy; both existing empty-draft reuse paths; background-follow-up carry removal; contract/default/event/helper/presentation retirement and persisted-keybinding compatibility; the two user guides; this complete implementation-unit directory in PR1.

OUT: unconditional Local overriding a configured worktree default (A1 expressly accepts defaults); resetting an invested draft merely by reopening it; global changes to `composerDraftStore` inheritance; deleting worktrees or `previousWorktreesDirectories`; removing explicit `New thread in this worktree`; any feature from 020/030/040/050 beyond packaging their design documents in PR1. A pending SSH label is implemented in 030 after its field exists, not by inventing that field here.

## Inputs and source verification

Read local `AGENTS.md`, 000, `/tmp/ssh-wt/E1-web.md` and architect proposal `/tmp/ssh-wt/01a12bef-12af-7953-b80e-586c1e221b17.md`. The requested server map `/tmp/ssh-wt/01a12bef-11a5-7f71-8bb1-debbb865eb09.md` does not exist (read returned ENOENT; directory listing confirms absence). PR1 server behavior was verified directly in `apps/server/src/keybindings.ts` and its tests; no replacement input was fabricated. Architect A1/A4/A14 inform this slice only through 000's accepted/amended dispositions.

All anchors below were checked in the shared coordinator checkout on 2026-10-12, before implementation. Re-anchor when parent starts wp1; sibling design writers may change unit documents, not these source references. No source implementation, branch operation, server or browser was run by this delegation.

## File change map

`MODIFY`/`DELETE` are implementation operations for the parent. This delegation writes only this decade document. Unit `NEW` rows mean include the design artifacts in PR1, regardless of whether another worker has already created them on disk.

| Operation | Exact repository path                                                        | Change                                                                                                                 |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| MODIFY    | `apps/web/src/components/BranchToolbar.logic.ts`                             | Plain labels; new pure `resolveWorkspaceChipLabel`; remove previous-worktree seed/label and timestamp import.          |
| MODIFY    | `apps/web/src/components/BranchToolbar.logic.test.ts`                        | Remove obsolete seed tests; label/remote suffix matrix.                                                                |
| MODIFY    | `apps/web/src/components/BranchToolbar.tsx`                                  | Mode text in combined/panel path, retired props/menu/subscription/handle; forward active environment to wide selector. |
| MODIFY    | `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`                   | Same chip rule in wide/locked states; retire sentinel/option/props.                                                    |
| MODIFY    | `apps/web/src/components/ComposerContextLabel.tsx`                           | Opt workspace labels out of icon-only overflow collapse; existing other controls keep the default.                     |
| MODIFY    | `apps/web/src/components/BranchToolbar.panel.test.tsx`                       | Extend existing real DOM interaction harness to combined, wide and locked states, retirement and compact mode.         |
| DELETE    | `apps/web/src/components/PreviousWorktreeItemContent.tsx`                    | Entire now-unused component.                                                                                           |
| MODIFY    | `apps/web/src/hooks/useHandleNewThread.ts`                                   | Resolve reset context for both empty-draft reuse branches with async race guards.                                      |
| MODIFY    | `apps/web/src/hooks/useHandleNewThread.test.ts`                              | State-based request/reset/race regression coverage; retain permission and origin tests.                                |
| MODIFY    | `apps/web/src/components/ChatView.tsx`                                       | Delete obsolete key event; background follow-up invokes default resolver without carried workspace options.            |
| MODIFY    | `apps/web/src/components/ChatView.logic.ts`                                  | Delete `resolveBackgroundDraftWorkspaceOptions`.                                                                       |
| MODIFY    | `apps/web/src/components/ChatView.logic.test.ts`                             | Delete helper import and obsolete carry expectation.                                                                   |
| MODIFY    | `apps/web/src/components/settings/SettingInheritance.test.ts`                | Assert Local in existing inheritance chain.                                                                            |
| MODIFY    | `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts`         | Remove retired default expectation and assert command absent from options/rows.                                        |
| MODIFY    | `apps/web/src/keybindings.test.ts`                                           | Remove previous-worktree default; verify mod+shift+l has no default action.                                            |
| MODIFY    | `apps/mobile/src/features/threads/new-task-context-presentation.ts`          | Return Local/Worktree/New worktree.                                                                                    |
| MODIFY    | `apps/mobile/src/features/threads/new-task-context-presentation.test.ts`     | Workspace label cases and test-title vocabulary.                                                                       |
| MODIFY    | `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`                    | Accessibility hint says Local.                                                                                         |
| MODIFY    | `apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx`    | Local option and inherited fallback copy.                                                                              |
| MODIFY    | `packages/contracts/src/keybindings.ts`                                      | Delete static command literal.                                                                                         |
| MODIFY    | `packages/shared/src/keybindings.ts`                                         | Delete mod+shift+l default.                                                                                            |
| MODIFY    | `apps/server/src/keybindings.ts`                                             | Drop retired raw entries before decoding in both disk loaders.                                                         |
| MODIFY    | `apps/server/src/keybindings.test.ts`                                        | Runtime/startup/mutation retirement and genuine-invalid-entry cases.                                                   |
| MODIFY    | `docs/user/keybindings.md`                                                   | Two workspace choices; retire shortcut guidance.                                                                       |
| MODIFY    | `docs/user/thread-sidebar.md`                                                | Default/empty-draft semantics and background follow-up correction.                                                     |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/000_plan.md`                         | Authoritative unit plan included unchanged by PR1.                                                                     |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/010_phase1_local_default.md`         | This executable PR1 design.                                                                                            |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/020_phase2_ssh_workspace_service.md` | Parent/sibling-owned complete service design included in PR1.                                                          |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/030_phase3_ssh_picker_ui.md`         | Parent/sibling-owned complete UI design included in PR1.                                                               |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/040_phase4_fetch_back_ui.md`         | Parent/sibling-owned complete reverse-action design included in PR1.                                                   |
| NEW       | `devlog/_fin/261012_ssh_worktree_picker/050_phase5_land.md`                  | Parent/sibling-owned complete landing design included in PR1.                                                          |

Verified consumers needing no independent source edit:

- `apps/web/src/components/chat/ThreadDetailsPanel.tsx:70` assembles shared toolbar props; `:110` renders `layout="panel"`, `panelSection="workspace"`, with environment options and Auto balance. Changing `RunContextSelector` changes this surface; no duplicated selector or panel prop is needed.
- `apps/web/src/components/settings/ProjectDefaultsSettings.tsx:235`, `:243` already call `resolveEnvModeLabel` for selected/default choices. The existing null reset at `:216` and guarded local/worktree update at `:227` stay intact.
- `apps/web/src/components/settings/SettingInheritance.tsx:59` already calls the same resolver. Keep Inherit/Mixed/Unavailable and source precedence; only its existing expected strings change.
- `packages/shared/src/projectSettings.ts:18`, `:129` owns default precedence; `packages/contracts/src/t3ProjectFile.ts:126` already has built-in `local`. No new settings migration is needed.

## 1. Labels, combined selector, wide selector and thread panel

### `apps/web/src/components/BranchToolbar.logic.ts`

Before at `:97`, `:107`, `:113`:

```ts
return mode === "worktree" ? "New worktree" : "Current checkout";
return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
// locked resolver's final line:
return effectiveEnvMode === "worktree" ? resolveEnvModeLabel("worktree") : "Local checkout";
```

Replace those returns and add the following exported pure function beside them. `EnvironmentOption` already exists at `:17`; EnvMode remains its existing two-value schema at `:26`.

```ts
export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Local";
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(
  activeWorktreePath: string | null,
  effectiveEnvMode: EnvMode,
): string {
  if (activeWorktreePath) return "Worktree";
  return resolveEnvModeLabel(effectiveEnvMode);
}

export function resolveWorkspaceChipLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  forceNewWorktree?: boolean;
  activeEnvironment?: Pick<EnvironmentOption, "isPrimary" | "label"> | null;
}): string {
  const modeLabel = input.forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : input.activeWorktreePath
      ? resolveCurrentWorkspaceLabel(input.activeWorktreePath)
      : resolveEnvModeLabel(input.effectiveEnvMode);
  return input.activeEnvironment && !input.activeEnvironment.isPrimary
    ? `${modeLabel} · ${input.activeEnvironment.label}`
    : modeLabel;
}
```

Delete the entire `PreviousWorktreeSeed` interface and both resolver functions at `:121`–`:166`, and unused `toSortableTimestamp` import at `:10`. Existing `resolveEffectiveEnvMode`, branch/worktree selection and Git behavior remain unchanged. A populated path takes precedence over mode for display (existing draft selection may encode `envMode: local` for an attached checkout); `forceNewWorktree` takes precedence over a path for multi-model submission.

### `apps/web/src/components/BranchToolbar.tsx`

Before at `:193`: mode is calculated, but trigger at `:260` replaces it with Auto balance or a machine label:

```tsx
{
  autoEnvironmentLabel ??
    (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel);
}
```

Replace workspaceLabel calculation with the shared function, including its new import:

```tsx
const workspaceLabel = resolveWorkspaceChipLabel({
  forceNewWorktree,
  activeWorktreePath,
  effectiveEnvMode,
  activeEnvironment,
});
```

Replace the trigger's label subtree at `:259`:

```tsx
<ComposerContextLabel displayMode={displayMode} collapseWhenCompact={false}>
  {workspaceLabel}
</ComposerContextLabel>
```

Machine icon tooltip `:249` remains `autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"`; it is the owner of machine/auto-balance copy. Workspace tooltip at `:222` uses workspaceLabel in composer mode; panel can keep its existing real path tooltip (`workspacePath ?? workspaceLabel`) for Copy full path. Remote mode text stays on the trigger even with Auto balance enabled. The panel's existing locked-workspace/unlocked-machine distinction at `:201` must remain.

Retire all previous-worktree plumbing:

- Delete imports `resolvePreviousWorktreeLabel`, `resolvePreviousWorktreeSeed`, `PreviousWorktreeItemContent` and `useThreadShellsForProjectRefs` (`:29`, `:37`, `:47`). Delete now-unused label resolver imports after workspaceLabel replacement; retain `resolveCurrentWorkspaceLabel`/`resolveEnvModeLabel` for menu choices.
- `BranchToolbarHandle` at `:76`: after is exactly `{ openBranchPicker: () => void }`.
- Delete `previousWorktreeLabel`, `previousWorktreeBranch`, `onUsePreviousWorktree` from `RunContextSelectorProps` at `:157` and destructuring at `:178`.
- Popup at `:308`: after `className={isPanel ? "w-(--anchor-width)" : undefined}`. Remove the old conditional width.
- Replace workspace radio handler `:369` with a two-value guard:

```tsx
onValueChange={(value) => {
  if (value === "local" || value === "worktree") onEnvModeChange(value);
}}
```

- Delete previous-worktree menu block `:393`–`:397`. Keep Local/Worktree current-context item and New worktree item, including existing `envModeLocked`/`forceNewWorktree` disabled states.
- Delete obsolete draft setter subscription `:629` and the whole lookup/seed/callback block `:643`–`:676`. This removes the project-thread subscription from rendering, rather than retaining hidden feature work.
- Replace imperative handle at `:678` with:

```tsx
useImperativeHandle(
  ref,
  () => ({
    openBranchPicker: () => branchSelectorRef.current?.open(),
  }),
  [],
);
```

- Delete retired prop forwarding on panel `:731`, combined composer `:785`, wide selector `:825`.
- To the wide selector invocation beginning `:819`, add `activeEnvironment={activeEnvironmentOption}`. This is the same owning environment resolved at `:700`, not the auto-balancer label.

Thread panel coverage is inherited through `ThreadDetailsPanel.tsx:110`. Keep its density branches: full density displays run context; other densities do not acquire a new control. Existing branch toolbar action “New thread in this worktree” remains the explicit entry point for continuing an existing tree.

### `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`

Current imports at `:7`, props at `:26`, menu values at `:49`, locked label at `:82`, trigger `SelectValue` at `:135`, and previous option at `:168` are independent from the narrow path.

Remove `PreviousWorktreeItemContent`, `PREVIOUS_WORKTREE_SELECT_VALUE`, all three retired props/destructured values, showPreviousWorktree, option spread, the previous select-handler branch, popup-width conditional and previous SelectItem. Remove unused `SelectValue`/`resolveLockedWorkspaceLabel` imports. Add `resolveWorkspaceChipLabel` and type `EnvironmentOption` imports. The new prop and calculations are:

```tsx
// In BranchToolbarEnvModeSelectorProps:
activeEnvironment?: Pick<EnvironmentOption, "isPrimary" | "label"> | null;
// In parameter destructuring:
activeEnvironment = null,
// In the function body:
const workspaceLabel = resolveWorkspaceChipLabel({
  forceNewWorktree,
  effectiveEnvMode,
  activeWorktreePath,
  activeEnvironment,
});
const envModeItems = useMemo(() => [
  { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
  { value: "worktree", label: resolveEnvModeLabel("worktree") },
], [activeWorktreePath]);
```

Locked row label `:82` and selectable row `:135` both become:

```tsx
<ComposerContextLabel collapseWhenCompact={false}>{workspaceLabel}</ComposerContextLabel>
```

The selectable TooltipPopup at `:139` becomes `{workspaceLabel}`. Locked TooltipPopup at `:93` keeps the multi-model explanation when forced, otherwise `{workspaceLabel}`. Menu items remain the current-context Local/Worktree label and New worktree; menu does not repeat the host suffix. Select handler at `:106` after:

```tsx
onValueChange={(value: string | null) => {
  if (value === "local" || value === "worktree") onEnvModeChange(value);
}}
```

Do not cast an arbitrary null/string into EnvMode. Null/non-mode values do nothing.

### `apps/web/src/components/ComposerContextLabel.tsx`

Current overflow classes at `:21` and `:30` collapse every label to an icon. M1 requires workspace mode text to remain visible; merely replacing the string at `BranchToolbar.tsx:260` would miss this state. Add optional `collapseWhenCompact?: boolean`, default true, alongside `displayMode` (`:9`–`:12`). Replace the class branches with:

```tsx
// Outer span, replacing the current toolbar branch:
displayMode === "panel"
  ? "flex-1 overflow-x-clip overflow-y-visible text-left"
  : cn("max-w-[240px]", collapseWhenCompact &&
      "group-data-[compact]/composer-context:max-w-0"),
// Inner span, replacing current displayMode === "toolbar" expression:
displayMode === "toolbar" && cn(
  "max-w-[240px] transition-opacity duration-180 ease-drawer motion-reduce:transition-none",
  collapseWhenCompact && "group-data-[compact]/composer-context:opacity-0",
),
```

Only the two workspace usages opt out. Keep measurable text, existing max width, truncation, reduced-motion behavior, overflow hysteresis, and existing transitions. No perpetual animation or extra observer. This adds one optional presentation prop, not a persisted setting.

### `apps/web/src/components/PreviousWorktreeItemContent.tsx`

Delete the full 19-line component (export at `:5`, label at `:10`) after removing both imports. Do not touch unrelated historical worktree-directory lookup/settings.

## 2. Reset both reuse paths and remove background carry

### `apps/web/src/hooks/useHandleNewThread.ts`

Existing request-boundary resolver at `:151` already reads target environment settings and t3.json correctly. Do not replace it with the primary device's defaults. Existing explicit-option picker at `:48` preserves absent keys; explicit callers such as New thread in this worktree keep that behavior.

Add this request-local helper immediately after `resolveDefaultEnvMode` (`:163`), using existing `NewThreadWorkspaceOptions` (`:38`):

```ts
const resolveRequestedWorkspaceContext = async (): Promise<NewThreadWorkspaceOptions> => {
  if (
    options?.branch !== undefined ||
    options?.worktreePath !== undefined ||
    options?.envMode !== undefined ||
    options?.startFromOrigin !== undefined
  ) {
    return pickExplicitWorkspaceOptions(options);
  }
  const defaultEnvMode = await resolveDefaultEnvMode();
  return {
    branch: null,
    worktreePath: null,
    envMode: defaultEnvMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode: defaultEnvMode,
      newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
    }),
  };
};
```

First reuse path at `:201`: replace the old comment saying already-open selections stand and the conditional context logic `:206`–`:261`. After:

```ts
const isDraftAlreadyOpen =
  currentRouteTarget?.kind === "draft" &&
  currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
const workspaceContext = await resolveRequestedWorkspaceContext();
if (routeChangedSinceRequest()) return null;
const routeTargetNow = getCurrentRouteTarget();
const openedMeanwhile =
  !isDraftAlreadyOpen &&
  routeTargetNow?.kind === "draft" &&
  routeTargetNow.draftId === emptyStoredDraftThread.draftId;
const currentMappedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
const currentDraft = getDraftSession(emptyStoredDraftThread.draftId);
const promotedMeanwhile =
  currentDraft == null ||
  currentDraft.promotedTo != null ||
  (storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null);
const remappedMeanwhile =
  currentMappedDraft?.draftId !== emptyStoredDraftThread.draftId ||
  currentDraft?.environmentId !== emptyStoredDraftThread.environmentId ||
  currentDraft?.projectId !== emptyStoredDraftThread.projectId ||
  currentDraft?.threadId !== emptyStoredDraftThread.threadId;
const investedMeanwhile = composerDraftHasUserContent(
  getComposerDraft(emptyStoredDraftThread.draftId),
);
if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) return null;
setDraftThreadContext(emptyStoredDraftThread.draftId, {
  ...workspaceContext,
  ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
  ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
});
```

The new request intentionally resets a draft that was already open at request start. A navigation that landed during the await is a stale request instead. Keep the existing model explicit-pick handling `:276`–`:290`. Keep passing `...workspaceContext` to `setLogicalProjectDraftThreadId` at `:301`: otherwise a logical-project member remap erases the context just written. Keep the post-write route re-read/no-duplicate-navigation guard at `:313`. Remove unused hasBranchOption/hasWorktreePathOption/hasEnvModeOption/hasStartFromOriginOption declarations `:167`–`:170` once neither path uses them. Rewrite the comment at `:211` to explain empty-draft reset plus race protection, not open-draft preservation.

Second active-empty fallback at `:329`: retain its condition and content/promoted/logical-project guards, replace its body with this async return:

```ts
return (async () => {
  const workspaceContext = await resolveRequestedWorkspaceContext();
  if (routeChangedSinceRequest()) return null;
  const activeNow = getDraftSession(currentRouteTarget.draftId);
  if (
    activeNow == null ||
    activeNow.promotedTo != null ||
    activeNow.logicalProjectKey !== logicalProjectKey ||
    activeNow.environmentId !== latestActiveDraftThread.environmentId ||
    activeNow.projectId !== latestActiveDraftThread.projectId ||
    activeNow.threadId !== latestActiveDraftThread.threadId ||
    readThreadShell(scopeThreadRef(activeNow.environmentId, activeNow.threadId)) !== null ||
    composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
  )
    return null;
  const mappedNow = getDraftSessionByLogicalProjectKey(logicalProjectKey);
  if (mappedNow && mappedNow.draftId !== currentRouteTarget.draftId) return null;
  setDraftThreadContext(currentRouteTarget.draftId, workspaceContext);
  setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
    threadId: latestActiveDraftThread.threadId,
    createdAt: latestActiveDraftThread.createdAt,
    runtimeMode: latestActiveDraftThread.runtimeMode,
    interactionMode: latestActiveDraftThread.interactionMode,
    ...workspaceContext,
  });
  return { draftId: currentRouteTarget.draftId, threadId: latestActiveDraftThread.threadId };
})();
```

This fallback matters when a route still references an empty session but the logical-project mapping is absent. No existing mapping is required, but a different mapping registered during the await wins. Do not reset permissions on this already-active fallback. Existing fresh creation at `:363`/`:403` stays unchanged, including explicit branch/path/origin and target permissions. Existing concurrent fresh-creation winner at `:371` stays unchanged: it is a winner of the same in-flight creation, not another deliberate request, and its explicit picks must not be overwritten by a losing invocation. Update the `:385` comment to describe that concurrency rule without referring to an obsolete open-draft preservation rule.

Do not modify `composerDraftStore.ts:1649` or `:2899` globally. In-place project/environment edits retain their current inheritance behavior; the reset is at the new-thread request boundary.

### `apps/web/src/components/ChatView.tsx`, `.logic.ts`, `.logic.test.ts`

Before at `ChatView.tsx:10018`:

```tsx
await handleNewThread(
  scopeProjectRef(activeProject.environmentId, activeProject.id),
  resolveBackgroundDraftWorkspaceOptions({
    envMode: sendEnvMode,
    branch: activeThreadBranch,
    startFromOrigin,
  }),
);
```

After:

```tsx
await handleNewThread(scopeProjectRef(activeProject.environmentId, activeProject.id));
```

Keep `markPromotedDraftThreadByRef` before opening (`:10015`) and the existing catch/clear/warning (`:10027`); sending the current thread still uses its explicit selection. Only the next draft stops carrying workspace context. Delete helper import at `ChatView.tsx:5`. Delete the entire obsolete keybinding branch `:8274`–`:8279` (the imperative member is gone). Preserve composer.workspace/branch/host commands.

Delete the entire exported `resolveBackgroundDraftWorkspaceOptions` at `ChatView.logic.ts:825`–`:841`. Delete its import `ChatView.logic.test.ts:41` and its describe block `:1693`–`:1708` (the closing `});` at :1708); keep the blank line and the following `describe("proactive completed diff guard"` suite that starts at `:1710`. Replace its regression proof at the new-thread request boundary, not with a mock asserting a callback was invoked.

## 3. Keybinding contract, default and persisted retirement

### Contract/default/client test changes

At `packages/contracts/src/keybindings.ts:98`, delete exactly `"composer.previousWorktree",` from `STATIC_KEYBINDING_COMMANDS`. `KeybindingCommand` at `:125` and `KeybindingRule.command` at `:142` then reject new attempts to set the retired command. At `packages/shared/src/keybindings.ts:182`, delete exactly:

```ts
{ key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
```

At `apps/web/src/keybindings.test.ts:1452`, delete `["l", "composer.previousWorktree"]` from the default shortcut table, and add platform-parametrized absence coverage using the existing `event`/`resolveShortcutCommand` helper. For MacIntel use metaKey; Win32/Linux ctrlKey; shift+l with `terminalFocus:false` yields no default command. A custom binding of those keys to an active command remains valid.

At `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts:33`, delete retired command from the expected editable defaults. Add `does not offer the retired previous-worktree command` checking both `buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "")` and `buildKeybindingCommandOptions([])` against that ID. The verified signature at `KeybindingsSettings.logic.ts:351` takes `ResolvedKeybindingsConfig` and returns command IDs; passing an empty binding array tests the static contract list directly. Settings derives options from the static contract, so no hardcoded source label is left to edit.

### `apps/server/src/keybindings.ts`

Both raw disk loaders must retire before schema decoding. Add this private helper beside other parsing helpers (near `:99`):

```ts
function isRetiredKeybindingEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "command" in entry &&
    entry.command === "composer.previousWorktree"
  );
}
```

At `:348`, before `decodeKeybindingRuleExit(entry)` inside `loadCustomKeybindingsConfig`:

```ts
if (isRetiredKeybindingEntry(entry)) return null;
```

At `:395`, first statement of the runtime loop, before `decodeKeybindingRuleExit(entry)`:

```ts
if (isRetiredKeybindingEntry(entry)) continue;
```

Leave indices taken from the original raw array (`:395`); do not prefilter the whole array and renumber genuine issues. A retired command is discarded regardless of obsolete shortcut/when syntax. Unknown commands, bad active shortcuts, nulls and malformed files still use existing issues/warnings. Match only this exact command, not a `composer.*` prefix.

Startup sync at `:522` loads the filtered runtime config, so retired rows no longer block default sync. Existing atomic write/migration machinery stays in place. Runtime read need not force rewriting an otherwise unchanged file; startup or the next normal mutation may remove the retired entry when that path already writes. Do not invent a schema migration or a new file format. Normal upsert payload decoding must continue to reject the retired command; retirement is only compatibility for saved disk entries.

`apps/server/src/keybindings.test.ts` uses raw JSON fixtures, because after removal a typed KeybindingRule cannot contain the retired literal. Add inside the existing `it.layer(NodeServices.layer)("keybindings", ...)` harness (`:61`):

```ts
it.effect("silently retires saved previous-worktree entries before decoding", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      keybindingsConfigPath,
      JSON.stringify([
        { key: "not+a+shortcut", command: "composer.previousWorktree", when: "(" },
        { key: "mod+j", command: "terminal.toggle" },
      ]),
    );
    const service = yield* Keybindings.Keybindings;
    const state = yield* service.loadConfigState;
    assert.deepEqual(state.issues, []);
    assert.isFalse(
      state.keybindings.some((rule) => String(rule.command) === "composer.previousWorktree"),
    );
    assert.isTrue(state.keybindings.some((rule) => rule.command === "terminal.toggle"));
  }).pipe(Effect.provide(layerKeybindings())),
);
```

Extend this fixture for the startup/upsert/removal paths and logger capture as specified below; do not silently accept every malformed entry to make it pass.

## 4. Settings and mobile plain labels

Web settings/default source is already covered by the shared resolver (verified `ProjectDefaultsSettings.tsx:235`/`:243`, `SettingInheritance.tsx:59`). No separate setting literal or new choice is needed. In `SettingInheritance.test.ts:74`, `:89`, `:91`, replace every expected `Current checkout` with `Local`. Keep the t3.json `New worktree` expectation and effective-layer flags. Existing projectSettings tests at `packages/shared/src/projectSettings.test.ts:153`–`:181` prove project/environment/file/built-in precedence unchanged.

`apps/mobile/src/features/threads/new-task-context-presentation.ts:5` after:

```ts
export function resolveNewTaskWorkspaceLabel(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly worktreePath: string | null;
}): "Local" | "Worktree" | "New worktree" {
  if (input.workspaceMode === "worktree") return "New worktree";
  return input.worktreePath ? "Worktree" : "Local";
}
```

Keep its mode/path semantics: mobile worktree mode requests creation even when a stale selected path exists. This phase changes vocabulary, not mobile flow/navigation. In existing `.test.ts` import `resolveNewTaskWorkspaceLabel`, and add:

```ts
describe("resolveNewTaskWorkspaceLabel", () => {
  it.each([
    ["local", null, "Local"],
    ["local", "/repo/.t3/worktrees/feature", "Worktree"],
    ["worktree", null, "New worktree"],
    ["worktree", "/stale/path", "New worktree"],
  ] as const)("labels %s at %s as %s", (workspaceMode, worktreePath, label) => {
    expect(resolveNewTaskWorkspaceLabel({ workspaceMode, worktreePath })).toBe(label);
  });
});
```

Rename test-title occurrences at `.test.ts:11` and `:58` from Current checkout to Local. At `NewTaskDraftScreen.tsx:1597` replace the hint with:

```tsx
accessibilityHint={`Switches to ${flow.workspaceMode === "local" ? "a new worktree" : "Local"}`}
```

Existing label/accessibilityLabel at `:1598`/`:1607` consume the updated resolver. At `SettingsServerControlsRouteScreen.tsx:94`, `:98`, after:

```ts
description: "Use the repository's t3.json, or Local.",
// local mode choice:
label: "Local",
```

Keep Inherit at environment scope and Use defaults at project scope. No mobile SSH UI.

## 5. User docs and complete unit packaging

At `docs/user/keybindings.md:28`–`:30`, before: current checkout, new worktree, previous worktree, mod+shift+l reuse. After replace that continuation with:

```md
workspace, and `mod+shift+g` for the Git branch. Choose **Local** or **New
worktree** from the workspace menu. To continue in an existing worktree, use
**New thread in this worktree** from the branch toolbar.
```

At `docs/user/thread-sidebar.md:8`–`:11`, replace the Start a thread introduction with:

```md
On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its workspace starts from the project's configured default, which falls back to
**Local**. Starting a new thread also resets an empty draft's workspace selection.
A draft with text or attachments stays saved with its selection. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.
```

At `:38`–`:39`, replace the background carry claim with:

```md
next draft uses the project's workspace default, which falls back to **Local**.
Choose **New worktree** again when the next task needs a separate checkout, or set
it as the project's default.
```

Do not add SSH instructions before 030/040 exist. Do not add internal feature catalogs. Parent includes all six files under this unit directory in PR1 after its independent design audit; this is the explicit 000 task override to the normal no-committed-plans rule. This worker cannot fill, amend or approve sibling files. New artifacts are Markdown design documents, not new runtime modules; the executable content for sibling PRs is owned by those decade docs.

## PLAN-FIELD-CHAIN-01

No new persisted field, RPC value, settings value or workspace mode is introduced. `local`/`worktree` retain their existing schemas; the word Local is presentation, not a new enum.

| Value / change                     | Creation → serialization → deserialization → consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing reset context             | `useHandleNewThread.ts` request helper → `setDraftThreadContext` and `setLogicalProjectDraftThreadId` → `composerDraftStore.ts:1584`/`:2894` stores explicit branch/path/env/origin → `partializeComposerDraftStoreState :2184`, session assignment `:2307`, existing JSON/deferred storage → persisted schema `:319`–`:332`, normalization `:1831`–`:1833`, hydration `:2593`–`:2596` → toolbar and ChatView send. No schema/version change. Generic inheritance remains for omitted keys outside this request. |
| `resolveWorkspaceChipLabel` result | Derived synchronously from existing mode/path/environment props → N/A serialization/deserialization (render-only string) → combined trigger, panel trigger, wide selected/locked trigger and tooltips. Does not become a persisted host or mode.                                                                                                                                                                                                                                                                 |
| `activeEnvironment` wide prop      | Outer BranchToolbar owning option at `:700` → new optional child prop → N/A serialization/deserialization (React prop, existing option type) → wide chip helper. No independent fetch/subscription.                                                                                                                                                                                                                                                                                                              |
| `collapseWhenCompact`              | Optional Boolean presentation prop with default true → N/A serialization/deserialization → ComposerContextLabel's class selection; only workspace consumers pass false. No persisted compact preference.                                                                                                                                                                                                                                                                                                         |
| Retired command                    | New creation prohibited by `STATIC_KEYBINDING_COMMANDS` removal → old saved JSON may still contain the string → both raw server loaders recognize/drop before decoding → compile/merge/publish contains only active commands → keybindings settings/options/ChatView never expose or execute it. Existing normal atomic writer serializes active rows only.                                                                                                                                                      |
| Future sshDestination              | N/A in wp1: 030 owns creation, persistence, reset/clear and all consumers. Its addition must extend this request boundary so a new request cannot preserve an SSH destination.                                                                                                                                                                                                                                                                                                                                   |

## Test changes and activation grounding

Exact existing files to change are in the map; there are no new test modules. Before/after for obsolete suites: remove previous seed/label describe blocks in `BranchToolbar.logic.test.ts:28`/`:102`; update existing label expectations around `:537`–`:566`; remove background-helper describe in `ChatView.logic.test.ts:1693`. Other behavior stays tested.

For `useHandleNewThread.test.ts`, its current mock returns null for all routes and always reports no content (`:176`, `:136`), so adding an open-draft title to that harness alone proves nothing. Extend route resolution to use test router params, make getDraftSession/content/shell/mapping individually controllable, and use the actual composer store for behavioral assertions. Preserve actual contract/environment exports when mocking their ancillary hooks: spread `importOriginal`, instead of the current all-export stubs. Remove the mocked composer module; use real `useComposerDraftStore`, `DraftId`, `ThreadId`, `EnvironmentId`, `ProjectId` and `scopeProjectRef`, while leaving React hooks/router/environment config controlled. Seed a stored session through `setLogicalProjectDraftThreadId` and clear its logical mapping only to activate the fallback. Reset real draft maps between cases using the existing reset shape at `composerDraftStore.test.ts:154`. Spy on the two setters only for old compatibility assertions; new assertions read `getDraftSession` and composer content. The settings mock must at least support nullable workspace defaults and project-file resolution; use the real shared resolver for precedence tests, not duplicated priority logic. Resolve delayed reads with a controlled Promise/Deferred, never sleeps.

| Exact test file                                                          | Named case(s) and activation → observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/BranchToolbar.logic.test.ts`                    | `labels Local, New worktree and attached Worktree plainly`: null/path and mode matrix. `appends only a non-primary environment label`: primary with several choices still Local; remote single/multiple choices produce Local · host/New worktree · host/Worktree · host. `force-new-worktree label wins over a stale path`: multi-model force flag → New worktree. Missing option → plain mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/components/BranchToolbar.panel.test.tsx`                   | Existing `keeps machine choices usable when the combined row's workspace is locked`: before trigger expectation `local` at `:69`; after `Worktree`, then open actual menu, worktree mutation disabled but selecting remote still invokes real action. `shows workspace mode across combined composer and full thread panel`: seed local/remote context, render both layouts, open each menu, select Local/New worktree and inspect resulting draft/context. `wide workspace selector shows mode and remote host`: render actual wide selector with activeEnvironment, open listbox, select Local/New worktree. `does not offer Previous worktree in any layout`: seeded recent worktree threads, open actual narrow/panel/wide menus, no retired option. `keeps the workspace label visible in compact context`: compact ancestor plus workspace opt-out, inspect visible DOM/browser style when permitted, mode never icon-only; avoid static-markup/prop wiring assertions. `ignores null and non-mode select values`: exercise the Select's clearing/no-selection boundary; no invalid mode reaches state. Keep existing path-copy cases (new worktree has no path; existing root/worktree copies path). |
| `apps/web/src/hooks/useHandleNewThread.test.ts`                          | `resets an already-open empty worktree draft to Local`: stale branch/path/origin, draft route at request start, no options → same ID, null branch/path, local, origin false, no extra navigation. `resets an inactive empty stored draft to resolved defaults`: stale state reopened → default values. `resets an active empty draft with no project mapping`: remove logical map while route still owns session → fallback resets and restores mapping. `preserves an invested draft and opens a fresh default draft`: text and attachment variants → old state/content unchanged, new Local session. `honors explicit workspace options on both reuse paths`: branch/path/worktree/origin caller options → no implicit reset. `re-resolves configured worktree defaults for empty reuse`: project/environment/t3.json worktree → worktree, target origin setting. `background follow-up resolves defaults after promotion`: mark first session promoted, then request without options → new default Local despite old worktree/base.                                                                                                                                                                      |
| `apps/web/src/hooks/useHandleNewThread.test.ts`                          | `abandons reuse when navigation changes during defaults read`: delayed t3.json, change href → null, no writes/navigation. `abandons reuse opened by another request`: initially inactive, another navigation lands → null. `allows reset when draft was already open at request start`: same unchanged route is not stale. `abandons reuse promoted during defaults read`: set promotedTo or install server shell → no reset. `abandons reuse remapped during defaults read`: another mapping registered, or the same draft moves to another physical environment/project or thread ID → winner retained. `abandons reuse when content arrives during defaults read`: text/attachment → preserved. `abandons active fallback when its session disappears or changes project`: delete/remap physical member or alter thread ID → null. `abandons active fallback when a competing project draft is mapped`: previously absent map gains another draft → winner retained. `retains concurrent fresh-creation winner context`: registered during fresh await → no duplicate draft or overwritten explicit picks. Retain all current target permission/origin cases and duplicate-navigation guard.             |
| `apps/web/src/components/ChatView.logic.test.ts`                         | Delete obsolete background carry suite only. Existing `resolveSendEnvMode` tests remain: Git preserves requested mode, non-Git coerces Local. Current launch failure and next-composer warning paths are preserved, not reimplemented here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/components/settings/SettingInheritance.test.ts`            | Existing `shows the checkout's t3.json as a layer for file-backed keys`: Local appears for built-in/environment layers; New worktree still effective from file, source flags unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/components/settings/KeybindingsSettings.logic.test.ts`     | `does not offer the retired previous-worktree command`: active defaults/command options have no ID; workspace/branch commands remain editable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/keybindings.test.ts`                                       | `mod+shift+l has no default action on %s`: Mac/Windows/Linux event with nonterminal focus → no command; explicit rebind to an active command still works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/mobile/src/features/threads/new-task-context-presentation.test.ts` | Parameterized `labels %s at %s as %s` above: root Local, selected path Worktree, worktree request New worktree even with stale path. Existing branch-selection tests keep their outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/server/src/keybindings.test.ts`                                    | `silently retires saved previous-worktree entries before decoding`: raw obsolete command with malformed key/when → absent, no issues/warnings, active row preserved. `does not renumber invalid entries after retirement`: obsolete row at index 0, genuine unknown at index 2 → issue index 2. `startup sync proceeds with only retired entries`: raw obsolete-only config → active defaults available and no retired binding. `upsert and removal tolerate retired disk rows`: activate second disk loader through normal mutations → filtered saved output, no invalid-entry warning. `rejects new previous-worktree bindings`: KeybindingCommand/KeybindingRule decode rejects literal. `keeps genuine malformed-config and invalid-command diagnostics`: unrelated bad rows/null/non-array still issues; existing cases retained. Capture Logger only around retirement cases to distinguish no issues from no warning.                                                                                                                                                                                                                                                                                |

Concrete after excerpts for the existing test files (not new modules):

`BranchToolbar.logic.test.ts`, add to the existing label section after removing retired seed suites:

```ts
it.each([
  ["local", null, true, "Local"],
  ["worktree", null, true, "New worktree"],
  ["local", "/wt", true, "Worktree"],
  ["worktree", "/wt", false, "Worktree · Build host"],
  ["local", null, false, "Local · Build host"],
] as const)(
  "shows %s at %s on primary=%s",
  (effectiveEnvMode, activeWorktreePath, isPrimary, label) => {
    expect(
      resolveWorkspaceChipLabel({
        effectiveEnvMode,
        activeWorktreePath,
        activeEnvironment: { isPrimary, label: "Build host" },
      }),
    ).toBe(label);
  },
);
```

`useHandleNewThread.test.ts`, after replacing the non-stateful composer mock with the real store and route resolver as specified above; this is the core regression assertion to reuse for the fallback variant:

```ts
it("resets an already-open empty worktree draft to Local", async () => {
  testState.reset(null);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const projectRef = scopeProjectRef(
    EnvironmentId.make("environment-ssh"),
    ProjectId.make("project-remote"),
  );
  const draftId = DraftId.make("draft-existing");
  const threadId = ThreadId.make("thread-existing");
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId("remote-project", projectRef, draftId, {
      threadId,
      envMode: "worktree",
      branch: "old-base",
      worktreePath: "/old/wt",
      startFromOrigin: true,
    });
  testState.router.state.matches = [{ params: { draftId } }];
  testState.router.state.location.href = `/draft/${draftId}`;
  const result = await useNewThreadHandler()(projectRef);
  expect(result).toEqual({ draftId, threadId });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  });
  expect(testState.router.navigate).not.toHaveBeenCalled();
});
```

The test router's navigate stub must update both href and params. Keep `resolveThreadRouteTarget` real (its `threadRoutes.ts:68` signature accepts draft/environment/thread params). For the active-empty fallback case, after seeding the session clear only `logicalProjectDraftThreadKeyByLogicalProjectKey`; the session and its content still exist. For deferred guards configure `defaultThreadEnvMode:null` so `readT3ProjectFile` actually awaits the controlled read; a non-null environment setting bypasses that read. Assert stored state before and after fulfilling the deferred read. These fixtures activate the hook itself and its store updates, not a copy of the reset algorithm.

`KeybindingsSettings.logic.test.ts`, after removing the old expected ID:

```ts
it("does not offer the retired previous-worktree command", () => {
  expect(
    buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "").some(
      (row) => String(row.command) === "composer.previousWorktree",
    ),
  ).toBe(false);
  expect(
    buildKeybindingCommandOptions([]).some(
      (command) => String(command) === "composer.previousWorktree",
    ),
  ).toBe(false);
});
```

`keybindings.test.ts`, add next to the existing shortcut table with the native `event` helper:

```ts
it.each(["MacIntel", "Win32", "Linux"])("mod+shift+l has no default action on %s", (platform) => {
  const key = event({
    key: "l",
    shiftKey: true,
    metaKey: platform === "MacIntel",
    ctrlKey: platform !== "MacIntel",
  });
  assert.strictEqual(
    resolveShortcutCommand(key, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform,
      context: { terminalFocus: false, draftThreadRoute: true },
    }),
    null,
  );
});
```

For select callback null/non-mode fault injection, mount the existing selector with a controlled test double only at the Base UI Select boundary, emit its typed `onValueChange` signal, and assert the actual draft state does not receive an invalid envMode. Successful selections still use the actual menu/listbox interaction tests. The guard's reachability is a library callback boundary, not a new user-facing clearing action.

No new product error stage is added in PR1. The guard paths introduced/changed are enumerated above: two-mode select guard, raw retirement match/nonmatch, async route/content/promotion/mapping/session guards and force/locked display. Request resolver errors still reject through existing caller behavior; the background catch (`ChatView.tsx:10027`) preserves its warning/cleanup. On failure opening the next composer, the already-started thread is not resubmitted. Existing no-project and non-Git UI paths remain without source-control controls.

Integrated client proof belongs to the parent after integration and only with existing user authorization for browsers/computer use. Capture before/after evidence for a primary Local/new-worktree draft, remote owner, Auto balance, locked existing worktree, Settings inheritance, compact/wide widths and mobile copy. No browser/server was started for this design. Desktop wraps web; there is no Electron IPC change. Providers and agent/scheduled launch services are unaffected because this is a client new-thread default boundary and keybinding retirement, not a server launch-default rewrite.

## Verifier commands and current-tree results (PLAN-VERIFIER-REAL-01)

Every recorded command ran from `/Users/jun/.goat/worktrees/goat/t3-8cf0da21`, with:

```sh
export PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
```

Run the same commands after implementation; baseline green does not establish the new cases. All test files listed already exist. `vp test run` is the built-in command, not the package test script. Do not use `vp check`, recursive test/typecheck, dev servers or a full suite here.

```sh
vp test run apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/keybindings.test.ts apps/web/src/components/settings/KeybindingsSettings.logic.test.ts apps/mobile/src/features/threads/new-task-context-presentation.test.ts apps/server/src/keybindings.test.ts
vp test run apps/web/src/components/BranchToolbar.panel.test.tsx apps/web/src/components/settings/SettingInheritance.test.ts packages/shared/src/projectSettings.test.ts
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/shared typecheck
vp run --filter t3 typecheck
vp lint apps/web/src/components/BranchToolbar.logic.ts apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/BranchToolbar.tsx apps/web/src/components/BranchToolbarEnvModeSelector.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/hooks/useHandleNewThread.ts apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/keybindings.test.ts apps/web/src/components/settings/KeybindingsSettings.logic.test.ts apps/mobile/src/features/threads/new-task-context-presentation.ts apps/mobile/src/features/threads/new-task-context-presentation.test.ts apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx packages/contracts/src/keybindings.ts packages/shared/src/keybindings.ts apps/server/src/keybindings.ts apps/server/src/keybindings.test.ts
vp lint apps/web/src/components/ComposerContextLabel.tsx apps/web/src/components/BranchToolbar.panel.test.tsx apps/web/src/components/settings/SettingInheritance.test.ts apps/mobile/src/features/threads/NewTaskDraftScreen.tsx
```

| Command above                                                          | Exit | Current-tree result                                                         | Reads change target?                                                                                                                        |
| ---------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| First focused test command                                             | 0    | 7 files, 426 tests passed, 2.93 s                                           | Yes: label/default/retirement/mobile files imported by focused suites. New cases are not implemented yet.                                   |
| Second focused test command                                            | 0    | 3 files, 25 tests passed, 1.68 s                                            | Yes: actual toolbar DOM and inheritance; read-only projectSettings regression proof.                                                        |
| `vp run --filter @t3tools/web typecheck`                               | 0    | `apps/web` tsc --noEmit executed                                            | Yes, web implementation/test targets.                                                                                                       |
| `vp run --filter @t3tools/mobile typecheck`                            | 0    | `apps/mobile` tsc --noEmit executed                                         | Yes, mobile implementation/test targets.                                                                                                    |
| `vp run --filter @t3tools/contracts typecheck`                         | 0    | `packages/contracts` tsc --noEmit executed; two existing Effect suggestions | Yes, removed command literal/type.                                                                                                          |
| `vp run --filter @t3tools/shared typecheck`                            | 0    | `packages/shared` tsc --noEmit executed; existing Effect suggestion         | Yes, default keybindings.                                                                                                                   |
| `vp run --filter t3 typecheck`                                         | 0    | `apps/server` tsc --noEmit executed; existing Effect suggestions            | Yes, retirement loader/test.                                                                                                                |
| First focused lint command                                             | 0    | Existing React/compiler and unused-import warnings; no failing lint exit    | Yes, all 18 named source/test files.                                                                                                        |
| Second focused lint command                                            | 0    | Existing NewTaskDraftScreen React warnings                                  | Yes, all four additional source/test files.                                                                                                 |
| Initial `vp run --filter @t3tools/server typecheck` (not a valid gate) | 0    | `No packages matched the filter: @t3tools/server`                           | **No**. Package name verified from `apps/server/package.json:2` as `t3`; corrected command executed above. Never count this no-op as proof. |

The full source changes, planned tests and unit artifacts still require parent implementation/audit and fresh exact-head hosted CI. These commands do not lint Markdown; confirm both user-guide text edits and all six unit docs in the parent diff review. The document worker does not add tests, run git commits or claim PR1 ready.

## Commit plan and PR draft

Parent-owned conventional commit subjects, one coherent PR:

1. `fix(web): reset new-thread workspace to project defaults` — both reuse paths, background carry removal and behavioral tests/user background guidance.
2. `fix(ui): show plain workspace mode labels across clients` — combined/wide/panel/settings/mobile labels, compact visibility, tests.
3. `fix(keybindings): retire previous worktree action` — contract/default/server compatibility, menus/helpers/component removal, tests and shortcut guide.
4. `docs: add SSH worktree picker implementation unit` — complete audited unit directory (000/010/020/030/040/050). Do not commit scratch explorer output, raw transcripts, browser credentials or PR-only images.

PR title: `fix(ui): default new threads to Local and simplify workspace choices`

PR body draft:

```md
New-thread actions can reuse an empty draft's previous worktree selection, and the
workspace chip can show only a machine name. Previous worktree adds another choice
and shortcut to that flow.

Resolve workspace defaults again for both empty-draft reuse paths and background
follow-ups. Local remains the built-in default; configured project defaults and
explicit worktree actions still apply. Show Local, New worktree or Worktree across
composer widths, the thread panel, settings and mobile, with a remote owner suffix.
Remove Previous worktree and silently retire its saved keybindings before decoding.
Update the user guides and include the complete SSH worktree picker design unit.

Validation: [replace with implementation-head focused test/typecheck/lint results
and exact-head goat-ci link]. Before/after UI evidence: [attach GitHub uploads].

Stack map: PR1 [this PR] → PR2 [service PR link] → PR3 [picker PR link] → PR4
[fetch-back PR link]; base dev. Landing follows 000 M6 and 050.

Model/harness: Codex (GPT-6), Codex API harness for this design; replace/add the
verified implementation model and harness when the implementation is complete.
```

Placeholders here are restricted to external PR numbers, future verification evidence and screenshots, not implementation decisions. Parent performs PR creation and hosted review. Do not use the model requested for other workers as an observed-model claim for this worker.

## Risks

- Resolving t3.json adds an await to previously synchronous active-empty reuse; post-await state guards are necessary. Guard tests need deferred reads and actual state, not timeout-based polling or only setter call counts.
- Resetting an empty already-open draft is deliberate A1 behavior, including a workspace-only pick with no text/attachment. Reopening invested drafts or explicit worktree actions must not reset them.
- Local is the built-in fallback, not an override of configured project/environment/t3.json defaults; documentation must preserve the accepted A1 meaning.
- M1 includes responsive compact state. Workspace opt-out uses more width on very narrow composers; retain host truncation and test composer overflow, keyboard reachability and branch controls. Other labels still collapse; no new animation machinery.
- Removing the schema command before raw-loader retirement creates configuration warnings and can block startup default sync. Change contract/default and both loaders in the same PR; retain genuine-invalid-entry indices/diagnostics.
- Existing server/package lint/typecheck suggestions are baseline, not feature failures. The initial wrong package filter returned 0 without checking any code and is explicitly excluded from proof.
- `sshDestination` does not exist yet; 030 must extend reset semantics without reintroducing carry from empty drafts. No premature SSH type/field here.
- Missing server explorer map is an input provenance gap, not a reason to invent server behavior. All PR1 server anchors were independently inspected.

## Plan conflicts

Current code contradicts accepted decisions at these verified anchors; this design resolves them without reopening 000:

1. **A1 vs open-empty preservation** — `apps/web/src/hooks/useHandleNewThread.ts:215`–`:223` intentionally leaves already-open empty context untouched; fallback `:329`–`:351` only applies explicit options. Both are changed to fresh default resolution above. Existing fresh-race winner preservation remains necessary concurrency behavior.
2. **A1 vs background carry and user guide** — `apps/web/src/components/ChatView.tsx:10020`, `ChatView.logic.ts:825`, test `:1693` and `docs/user/thread-sidebar.md:38` explicitly preserve prior mode/base. Remove/correct them together.
3. **M1 vs machine-only text** — `apps/web/src/components/BranchToolbar.tsx:260` replaces mode with machine/auto label, including the panel; wide selector lacks the remote suffix. Both use the shared mode-first resolver.
4. **M1 vs compact label collapse** — `apps/web/src/components/ComposerContextLabel.tsx:21`/`:30` hides all text in compact mode. Workspace-only opt-out above resolves the literal always-visible mode requirement; other responsive controls retain their existing behavior.
5. **M2 vs old settings/mobile copy** — web label helpers at `BranchToolbar.logic.ts:98`/`:108`/`:118`, inherited test strings, mobile resolver `new-task-context-presentation.ts:8`/`:12` and mobile setting `SettingsServerControlsRouteScreen.tsx:98` use old names. Covered by the label/copy changes.
6. **D-u3/A4 vs feature and saved-config decoding** — menus/handle/helpers/default/contract still expose Previous worktree; server `keybindings.ts:349`/`:396` decodes it as an ordinary rule. Removing only the command would create warnings. Both raw loaders retire it first.

No unresolved decision conflict. The absent server map is recorded under Inputs and risks; it is not a competing policy or amended decision.
