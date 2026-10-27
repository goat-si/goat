# 030 wp3 / PR3 — saved SSH worktree picker and remote submission

## Stale check at wp3 P (branch goat/ws-picker-2-ssh-service a27a90042 = PR1 + dev 034041ce4 + PR2)

These amendments override older excerpts. Line anchors below are historical (ba65eae6b); re-locate by content.
Full anchor map: Archimedes stale check (gpt-6.1-sol) summarized here.

1. PR1 and PR2 are implemented. Real names: `createVcsEnvironmentAtoms(...).sshWorkspaceLaunch` /
   `.sshWorkspaceFetchBack` (packages/client-runtime/src/state/vcs.ts), `WS_METHODS.sshWorkspaceLaunch`
   (packages/contracts/src/rpc.ts), schemas in packages/contracts/src/sshWorkspace.ts. All 25 error codes and
   7 stages match the copy table below.
2. Labels: wrap PR1's `resolveWorkspaceChipLabel` (apps/web/src/components/BranchToolbar.logic.ts) in a
   pending-SSH helper that returns `Worktree · <saved label>` when an SSH destination is selected; do not pass
   the saved host as `activeEnvironment` (that yields "New worktree · …"). PR1 already removed the Auto/
   environment label override; the trigger renders `{workspaceLabel}`. Keep `collapseWhenCompact={false}`.
3. New-thread reset: there is no `hasExplicitWorkspaceOption`. Add SSH destination to
   `pickExplicitWorkspaceOptions` / `resolveRequestedWorkspaceContext` in useHandleNewThread.ts, and compare
   SSH destination identity in `workspaceSelectionChanged` so a host pick during a pending defaults read is kept.
4. Composer: the model picker disable expression is the `ProviderModelPicker` one in ChatComposer.tsx (the old
   anchor was deleted on dev); the noProviderAvailable reference near the keyboard handler is a dependency-array
   entry, not a guard.
5. `clearComposerDraftContent` binding, toast action shape, send guards, upload and turn start moved by a few
   lines in ChatView.tsx; semantics unchanged.
6. Wide selector: `PreviousWorktreeItemContent` and `SelectValue` are already gone; replace only the remaining
   Select-family imports with the shared menu.

Depends on: [020_phase2_ssh_workspace_service.md](020_phase2_ssh_workspace_service.md), after [010_phase1_local_default.md](010_phase1_local_default.md).
Authority: [000_plan.md](000_plan.md), including every D-u disposition, A1–A14 disposition and M1–M6.
Implementation branch: `goat/ws-picker-3-ssh-ui`; PR base: `goat/ws-picker-2-ssh-service`.
This is the diff-level implementation specification, not implementation evidence. Anchors below were read in the current coordinator tree on 2026-10-12; PR1/PR2 have not landed in this tree. Refresh anchors against PR2 before implementation. Only this document was written by the delegated worker. LOOP-REPAIR-01 changed-plan amendment: after three failed audit rounds, main replaced submission locking with content-snapshot consumption. This is a re-plan, not an audit PASS; the delegated worker owns no FSM/loop/goal, implementation or other document.

## Scope

IN:

- Preserve `envMode: "local" | "worktree"`; add optional draft-only SSH destination identity. The source draft's environment/project remain local; delete that draft only after opening the remote route succeeds.
- List only saved `SshConnectionProfile` catalog routes, including alternate `connectionRoutes(entry)`. Deduplicate full SSH targets. Disabled saved entries remain visible and disabled.
- Add `Worktree on SSH` with an inline-end/right submenu to compact composer, wide composer and workspace details panel. Replace the wide `Select` with the same menu contents. Hide the entry when there are no saved SSH profiles.
- Pending chip reads `Worktree · <saved label>` (M1); all other labels inherit PR1's mode-first rule. Selecting Local/New worktree or Run on clears SSH. Selecting SSH freezes source selection and automatic routing.
- Send through PR2's guarded launch command on the source environment, before normal worktree branch validation or attachment uploads. Capture DraftId and an immutable snapshot of its submitted composer content before awaits. Keep the composer editable; use existing isSendBusy/sendInFlightRef behavior only. Order: launch → bounded waitForThreadShell → navigate(replace) to the saved connection's `/$environmentId/$threadId` → compare current captured-draft content → clearDraftThread(captured DraftId) only if unchanged.
- Keep the entire current draft on failure or uncertain launch and surface code-specific feedback. Return `{kind: "opened", remoteRef}` after successful navigation: if content is unchanged, delete the captured draft; otherwise leave it untouched as an ordinary sidebar draft. Return `{kind: "started-not-opened", remoteRef, reason}` after acknowledged launch but failed opening: if unchanged, clearComposerDraftContent(captured DraftId) while retaining session/mapping; if changed, leave it untouched. onSend shows `Started on <host>, but could not open the thread` with an `Open thread` action either way; it reconnects/waits/navigates without launching. No remote recovery metadata is persisted. Uncertain launch has no automatic retry or operation recovery endpoint (A11).
- SSH send is disabled with a reason if any image/file attachment or multiple model selection is present. Environment-bound context records also block SSH send: this first version sends a plain text message without silently dropping context.

OUT: Git snapshot/SSH server implementation; password authentication; host discovery; browser gateway; a third settings mode; mobile SSH picker; fetch-back action and user docs (PR4); operation receipts/readOperation/connect; changing model/provider adapters; creating PRs/branches or starting a server during this design task.

Surface coverage: web code supplies the Electron client; plain browser with no saved profiles has no SSH entry, and a browser with stale imported SSH catalog entries shows them disabled with the desktop-only reason. Mobile receives no SSH field/UI change. Settings remain two workspace defaults. Workspace keybinding opens the existing shared menu trigger, and all send intents/keyboard/direct annotation actions pass the same SSH guard. Backend/MCP launch and remote setup scripts belong to PR2. Local, remote and tunnel source environments are checked explicitly: this PR offers SSH transfer only from this device's primary source environment. A preexisting remote project/thread is never required for selecting a saved host.

## Dependency contract and source evidence

The required server explorer `/tmp/ssh-wt/01a12bef-11a5-7f71-8bb1-debbb865eb09.md` was absent at design time. The web map `/tmp/ssh-wt/E1-web.md` and architect proposal `/tmp/ssh-wt/01a12bef-12af-7953-b80e-586c1e221b17.md` were read. The proposal is subordinate to 000: its receipts, browser gateway, extra scopes, anchor branch and additional RPCs are not adopted.

PR2 was available at the final reconciliation. Its client-runtime factory is the existing `createVcsEnvironmentAtoms`, extended with `sshWorkspaceLaunch` and `sshWorkspaceFetchBack` (see [020 — Layer/handler/client integration](020_phase2_ssh_workspace_service.md#layerhandlerclient-integration), guarded commands beside createWorktree). PR3 consumes `vcsEnvironment.sshWorkspaceLaunch`, instantiated already in `apps/web/src/state/vcs.ts:8`, through useAtomCommand. Define the local alias `const sshWorkspaceLaunchCommand = vcsEnvironment.sshWorkspaceLaunch` for the code below. No new bridge or client command factory is needed. PR4 consumes `vcsEnvironment.sshWorkspaceFetchBack`. Never import a raw RPC client into ChatView. Required wire shape is 020:115–143:

```ts
// Wire types are defined and exported by PR2.
import type { SshWorkspaceLaunchInput, SshWorkspaceLaunchResult } from "@t3tools/contracts";
type LaunchInput = SshWorkspaceLaunchInput;
type LaunchResult = SshWorkspaceLaunchResult;
// UI needs sourceProjectId, destination {connectionId, expectedEnvironmentId, target},
// title, modelSelection, runtimeMode, interactionMode, initialMessage {text}.
// A successful response must identify remoteEnvironmentId and remoteThreadId.
// No client operationId: M3 assigns it in the server.
```

The input/result mappings below match 020 exactly: sourceProjectId, destination.expectedEnvironmentId, initialMessage.text, remoteEnvironmentId and remoteThreadId. Do not add contracts to PR3. PR2 requires text-only transfer, matching the attachment/context guards here. Source model IDs are environment-local; a saved selection is not evidence that the remote has that provider. The remote validates it and a refusal keeps the draft.

Verified reusable boundaries:

| Current anchor                                                                                                                                      | Fact used in this design                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/client-runtime/src/connection/catalog.ts:44`                                                                                              | Saved SSH profile includes connectionId, environmentId, label and the full target.                                                                                                                                                             |
| `packages/client-runtime/src/connection/routes.ts:49`, `:430`                                                                                       | All preferred/alternate routes; target equality includes alias, hostname, username and port.                                                                                                                                                   |
| `packages/client-runtime/src/state/connections.ts:23`, `:69`, `:185`                                                                                | Catalog entries include disabled entries; catalog value atom; retryNow takes EnvironmentId directly.                                                                                                                                           |
| `apps/web/src/connection/catalog.ts:5`                                                                                                              | The web runtime's environmentCatalog instance.                                                                                                                                                                                                 |
| `apps/web/src/connection/platform.ts:279`, `:290`                                                                                                   | Provision/prepare SSH require desktopBridge. No new browser transport is planned.                                                                                                                                                              |
| `packages/client-runtime/src/state/runtime.ts:744`, `:792`, `:808`                                                                                  | Guarded environment command checks execution permission and exposes permissionAtom.                                                                                                                                                            |
| `apps/web/src/state/use-atom-command.ts:10`                                                                                                         | useAtomCommand returns tagged Success/Failure, not a raw throwing RPC Promise.                                                                                                                                                                 |
| `apps/web/src/state/entities.ts:201`                                                                                                                | waitForThreadShell waits for a scoped remote shell; returns false on timeout.                                                                                                                                                                  |
| `apps/web/src/threadRoutes.ts:41`                                                                                                                   | buildThreadRouteParams preserves both remote environment and thread IDs.                                                                                                                                                                       |
| `apps/web/src/components/chat/ChatComposer.tsx:7630`–`:7635`, `:3040`, `:4200`, `:4344`, `:5569`                                                    | Editor disabled expression excludes isSendBusy; send controls and model trigger already use isSendBusy. Preserve those existing behaviors; add no SSH read-only path.                                                                          |
| `apps/web/src/composerDraftStore.ts:3013`                                                                                                           | clearDraftThread removes a draft and its content/mapping without a remote promotion target.                                                                                                                                                    |
| `apps/web/src/components/ThreadRouteView.tsx:137`, `:169`                                                                                           | A missing draft session redirects to `/` and removes ChatView. Keep the session until remote navigation resolves.                                                                                                                              |
| `apps/web/src/components/ChatView.tsx:1833`; `apps/web/src/composerDraftStore.ts:717`, `:4186`                                                      | The selector alias is clearComposerDraftContent, bound to store.clearComposerContent; clears content only, preserving the draft session/mapping.                                                                                               |
| `apps/web/src/composerDraftStore.ts:388`–`:397`, `:427`–`:442`, `:4196`–`:4206`                                                                     | Content fields are prompt, images, files, nonPersistedImageIds, persistedAttachments, terminalContexts, previewAnnotations (element context), reviewComments and threadContexts. Compare content rather than model/runtime/workspace metadata. |
| `apps/web/src/components/Sidebar.tsx:994`, `:1002`–`:1006`; `apps/web/src/composerDraftStore.ts:427`–`:442`                                         | An ordinary non-promoted draft with user content remains a sidebar row; preserving a changed draft needs no Sidebar edit.                                                                                                                      |
| `apps/web/src/components/desktop/SnapShotCoordinator.tsx:141`–`:180`                                                                                | Asynchronous desktop capture writes directly through store.addImage and syncPersistedAttachments; completion must preserve additions without guarding this writer.                                                                             |
| `apps/web/src/components/ChatView.tsx:896`–`:924`, `:3591`–`:3607`; `apps/web/src/components/BranchToolbar.tsx:333`, `:350`, `:377`, `:387`, `:641` | Existing local dispatch owns isSendBusy. Workspace/Run on controls currently use envLocked/envModeLocked, not isSendBusy; no new submission-derived envLocked is introduced.                                                                   |

## File change map

Paths are relative to the repository root. Previous worktree removal belongs to PR1. Withdraw the previously proposed state/sshWorktreeSubmission.ts module and its lock tests; if they or lock-only guards were already added during repair, remove them during implementation. No replacement lock store, read-only path or submission-derived envLocked is in scope.

| Change | Exact path                                                 | What changes                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MODIFY | `apps/web/src/composerDraftStore.ts`                       | SSH destination schema/type/options, invariant enforcement, equality and full storage chain.                                                                                                    |
| MODIFY | `apps/web/src/composerDraftStore.test.ts`                  | Destination round-trip/reset behavior; unchanged-content deletion/clearing preserves the correct captured-ID/session/mapping boundaries.                                                        |
| MODIFY | `apps/web/src/hooks/useHandleNewThread.ts`                 | Extend PR1 reset/explicit option paths with destination null/identity.                                                                                                                          |
| MODIFY | `apps/web/src/hooks/useHandleNewThread.test.ts`            | Reused/fresh/invested/racing SSH draft behavior.                                                                                                                                                |
| MODIFY | `apps/web/src/components/BranchToolbar.logic.ts`           | Add pending SSH label helper.                                                                                                                                                                   |
| MODIFY | `apps/web/src/components/BranchToolbar.logic.test.ts`      | Label matrix including unavailable saved destination.                                                                                                                                           |
| NEW    | `apps/web/src/lib/sshWorktree.ts`                          | Saved route enumeration, identity lookup and shared send guard. Full code below.                                                                                                                |
| NEW    | `apps/web/src/lib/sshWorktree.test.ts`                     | Catalog alternate-route/dedup and every guard activation.                                                                                                                                       |
| NEW    | `apps/web/src/components/WorkspaceMenuItems.tsx`           | Reusable Local/New worktree/SSH submenu contents. Full code below.                                                                                                                              |
| MODIFY | `apps/web/src/components/BranchToolbar.tsx`                | Thread new props, pending label, shared menu contents, lock source/branch editing.                                                                                                              |
| MODIFY | `apps/web/src/components/BranchToolbarBranchSelector.tsx`  | Block automatic base selection and imperative/manual branch changes during pending SSH.                                                                                                         |
| MODIFY | `apps/web/src/components/chat/ChatComposer.tsx`            | Skip source-specific provider send blocks for an SSH destination; retain existing isSendBusy controls and editable composer, remove any repair-added submission mutation guards/read-only path. |
| NEW    | `apps/web/src/components/chat/ChatComposer.ssh.test.tsx`   | Exercise provider-block override, readiness guards and typing/paste remaining available during SSH busy state; replace lock-only tests.                                                         |
| MODIFY | `apps/web/src/components/BranchToolbarEnvModeSelector.tsx` | Replace Select with Menu; same shared submenu at wide width.                                                                                                                                    |
| MODIFY | `apps/web/src/components/chat/ThreadDetailsPanel.tsx`      | Forward the same SSH props to panel toolbar.                                                                                                                                                    |
| MODIFY | `apps/web/src/components/ChatView.tsx`                     | Catalog and permission wiring, destination selection/reset, guarded SSH send branch, feedback, navigation.                                                                                      |
| MODIFY | `apps/web/src/components/ChatView.logic.ts`                | Small pure snapshot/comparison functions for every current composer content field; no revision counter, state store or route opt-out.                                                           |
| MODIFY | `apps/web/src/components/ChatView.logic.test.ts`           | Content equality/change coverage, including image/capture addition and context changes with the same ID.                                                                                        |
| NEW    | `apps/web/src/lib/sshWorktreeSubmission.ts`                | One-shot launch, discriminated outcome, navigate-before-delete, conditional content consumption and connect-only Open action. Full code below.                                                  |
| NEW    | `apps/web/src/lib/sshWorktreeSubmission.test.ts`           | Observed command/persistence/navigation sequences and failure retention.                                                                                                                        |
| NEW    | `apps/web/src/components/ChatView.ssh.test.tsx`            | Mount the real ChatView to prove SSH branch activation, bypass and duplicate-send behavior.                                                                                                     |
| MODIFY | `apps/web/src/components/BranchToolbar.panel.test.tsx`     | Exercise real compact/panel/wide menus and disabled states with DOM events.                                                                                                                     |

PR2 command binding reconciliation: **no additional bridge file**. Use the existing web `vcsEnvironment`; command aliases above are local names, not additional exports.

## 1. Draft field chain — composerDraftStore.ts

Current type is `DraftSessionState` at `apps/web/src/composerDraftStore.ts:451`. Storage version is 9 at `:91`, persisted draft schema is at `:319`, factory at `:1584`, comparison at `:1672`, legacy normalization at `:1725` (normalization assignment at `:1808`), partializer at `:2184`, hydrator at `:2575`, context reconstruction at `:2879` and draft removal at `:3013`.

Before:

```ts
const COMPOSER_DRAFT_STORAGE_VERSION = 9;
// PersistedDraftThreadState and DraftSessionState:
envMode: DraftThreadEnvMode;
startFromOrigin: boolean;
// Context reconstruction:
envMode: options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
startFromOrigin: nextStartFromOrigin,
```

After: add this schema before PersistedDraftThreadState and add the field to both persisted/runtime schemas. Use a nullable optional value so null clears and undefined preserves; legacy absence means no destination.

```ts
const COMPOSER_DRAFT_STORAGE_VERSION = 10;
export const DraftSshDestinationSchema = Schema.Struct({
  connectionId: Schema.String.check(Schema.isMinLength(1)),
  environmentId: EnvironmentId,
});
export type DraftSshDestination = typeof DraftSshDestinationSchema.Type;
const isDraftSshDestination = Schema.is(DraftSshDestinationSchema);
// PersistedDraftThreadState:
sshDestination: Schema.optionalKey(Schema.NullOr(DraftSshDestinationSchema)),
// DraftSessionState:
sshDestination?: DraftSshDestination | null;
```

Add `sshDestination?: DraftSshDestination | null` to **all four option definitions**: store `setLogicalProjectDraftThreadId` at `:536`, `setProjectDraftThreadId` at `:553`, `setDraftThreadContext` at `:569`, private `createDraftThreadState` at `:1589`. Preserve the existing `setProjectDraftThreadId` forwarding at `:2824`.

Add this shared pure resolver inside composerDraftStore.ts. It intentionally recognizes manual workspace edits so clicking New worktree while SSH is selected clears the destination even when envMode remains worktree. Project changes clear the source-bound choice, never retarget the draft to the SSH host.

```ts
function resolveDraftSshDestination(input: {
  previous: DraftSshDestination | null | undefined;
  requested: DraftSshDestination | null | undefined;
  projectChanged: boolean;
  workspaceEdited: boolean;
  envMode: DraftThreadEnvMode;
  worktreePath: string | null;
  startFromOrigin: boolean;
}): DraftSshDestination | null {
  const candidate =
    input.requested !== undefined
      ? input.requested
      : input.projectChanged || input.workspaceEdited
        ? null
        : (input.previous ?? null);
  return input.envMode === "worktree" && input.worktreePath === null && !input.startFromOrigin
    ? candidate
    : null;
}
function draftSshDestinationsEqual(
  left: DraftSshDestination | null | undefined,
  right: DraftSshDestination | null | undefined,
): boolean {
  return left == null || right == null
    ? left == null && right == null
    : left.connectionId === right.connectionId && left.environmentId === right.environmentId;
}
```

At both factory `:1630` and setter `:2879`, compute `nextEnvMode` once from the existing expression, then:

```ts
const sshDestination = resolveDraftSshDestination({
  previous: existingThread?.sshDestination, // setter: existing.sshDestination
  requested: options?.sshDestination,      // setter: options.sshDestination
  projectChanged,
  workspaceEdited:
    options?.envMode !== undefined || options?.branch !== undefined ||
    options?.worktreePath !== undefined || options?.startFromOrigin !== undefined,
  envMode: nextEnvMode,
  worktreePath: nextWorktreePath,
  startFromOrigin: nextStartFromOrigin,
});
// in returned/reconstructed draft:
envMode: nextEnvMode,
sshDestination,
...(sshDestination ? { environmentSelection: "manual" as const, loadBalancedEnvironmentId: null } : {}),
```

Explicit destination selection includes worktree/false/null together; it takes precedence over workspaceEdited. Runtime/interaction/model updates omit workspace keys and preserve SSH. Ordinary branch-selector automatic initialization must not clear SSH: lock that component as described in section 4 so initialization and human Git changes do not run during SSH selection.

Add `draftSshDestinationsEqual(left.sshDestination, right.sshDestination)` to factory equality `:1672` and setter unchanged check `:2904`; otherwise changing only host becomes a false no-op.

Legacy normalization `:1808`: after envMode/worktree/startFromOrigin normalization, read candidate using the hoisted validator. Valid pending SSH data must force manual source routing. Invalid non-null payload must never silently become an ordinary local worktree: preserve the raw draft content but set an invalid destination sentinel `{connectionId: "unavailable", environmentId: normalizedEnvironmentId}` so Send fails the saved-connection lookup until reselection. Existing absence/null remains null.

```ts
const rawSshDestination = candidateDraftThread.sshDestination;
const normalizedSshDestination = rawSshDestination == null
  ? null
  : isDraftSshDestination(rawSshDestination)
    ? rawSshDestination
    : { connectionId: "unavailable", environmentId: normalizedEnvironmentId };
// assignment in normalized draft:
sshDestination: normalizedSshDestination,
...(normalizedSshDestination ? {
  envMode: "worktree" as const, worktreePath: null, startFromOrigin: false,
  environmentSelection: "manual" as const, loadBalancedEnvironmentId: null,
} : {}),
```

The sentinel is only for malformed persisted data; it creates no catalog route or server target. On incompatible but syntactically valid stored values, also enforce the same worktree/null/false invariant rather than discarding the user's destination intent. Reselection or choosing Local clears it through normal store options. This avoids adding a persistent error field.

Partializer `:2307` currently assigns the entire draft object, so the new field already serializes. Make this explicit for absent legacy values:

```ts
persistedDraftThreadsByThreadKey[threadKey] = {
  ...draftThread,
  sshDestination: draftThread.sshDestination ?? null,
};
// hydrator at :2596:
sshDestination: persistedDraftThread.sshDestination ?? null,
```

The legacy fallback reconstruction at `:1887` creates a genuinely empty legacy draft without destination: add `sshDestination: null`. Current normalization at `:2331` already calls the legacy normalizer, so migration and merge share the new handling. No separate JSON reviver, server serialization or mobile decoder exists for this client-local draft.

Capture the content snapshot separately from this persisted destination field chain. After bounded shell wait and remote navigation resolve, SSH opened re-reads the captured DraftId's current content and calls existing `clearDraftThread(capturedDraftId)` at `apps/web/src/composerDraftStore.ts:3013` only if unchanged; removal uses `removeDraftThreadReferences` at `:1690` without a composerDestination. Changed content leaves the ordinary draft, session and mapping untouched, so its invested content remains visible in Sidebar. SSH started-not-opened performs the same comparison and, only if unchanged, uses ChatView's existing clearComposerDraftContent selector alias (`ChatView.tsx:1833` → `composerDraftStore.ts:4186`) while retaining the session, destination and mapping. Changed content is untouched. No comparison/clear runs for launch failure or launch_uncertain. Do not call promotion/finalization helpers or extend cross-environment draft lookup for SSH. The saved remote ref lives only in the outcome/navigation continuation/toast closure; no new acknowledgement field, storage chain or remote recovery draft is added. Sidebar.tsx is untouched.

## 2. New-thread reset — useHandleNewThread.ts

Current workspace option definition/picker is `apps/web/src/hooks/useHandleNewThread.ts:38`, `:48`, handler options `:69`; reuse reset `:252`, active-empty remap `:346`, fresh creation `:403`, raced-winner forwarding `:389`. Implement on PR1's resolved-default logic, retaining its concurrency rechecks.

Before:

```ts
interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}
```

After: import DraftSshDestination type; add destination to NewThreadWorkspaceOptions and public handler options, explicit-key detection and `pickExplicitWorkspaceOptions`:

```ts
sshDestination?: DraftSshDestination | null;
// pickExplicitWorkspaceOptions result:
...(options?.sshDestination !== undefined ? { sshDestination: options.sshDestination } : {}),
// explicit-option flag:
const hasSshDestinationOption = options?.sshDestination !== undefined;
```

Add that flag wherever `hasExplicitWorkspaceOption` is calculated. Add `sshDestination: null` to PR1's resolved defaults for both reusable-empty paths and fresh creation, then spread explicit options **after** defaults. A raced winning draft retains its existing SSH choice unless explicit options request a change; do not inject null into that loser path. The new handler does not pick SSH by default. The background fresh-composer call remains PR1's default resolver and cannot carry the just-submitted SSH target.

## 3. NEW apps/web/src/lib/sshWorktree.ts

Full new module; uses the already existing connection catalog API (`catalog.ts:44`, `routes.ts:49`, `:430`) and store type from section 1. It builds candidates from the catalog, not environment presentations or discovered aliases; disabled saved entries must survive enumeration. The retained profile supplies the full saved target at the instant of send.

```ts
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  ConnectionCatalogEntry,
  SshConnectionProfile,
} from "@t3tools/client-runtime/connection";
import { connectionRoutes, sshTargetKey } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { DraftSshDestination } from "../composerDraftStore";

export interface SavedSshWorktreeOption {
  destination: DraftSshDestination;
  profile: SshConnectionProfile;
  label: string;
  disabledReason: string | null;
}
export function savedSshWorktreeOptions(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  desktopAvailable: boolean,
): SavedSshWorktreeOption[] {
  const candidates: SavedSshWorktreeOption[] = [];
  for (const [environmentId, entry] of entries) {
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (route.target._tag !== "SshConnectionTarget" || profile?._tag !== "SshConnectionProfile")
        continue;
      // A saved profile is expected to identify its containing environment.
      if (
        profile.environmentId !== environmentId ||
        profile.connectionId !== route.target.connectionId
      )
        continue;
      candidates.push({
        destination: { connectionId: profile.connectionId, environmentId },
        profile,
        label: profile.label.trim() || entry.target.label || profile.target.alias,
        disabledReason: !desktopAvailable
          ? "SSH worktrees are available in the desktop app."
          : !entry.enabled
            ? "Enable this saved connection in Settings → Connections."
            : (entry.unsupportedReason ?? null),
      });
    }
  }
  // Enabled/usable route wins duplicates; stable tie-break makes choice deterministic.
  candidates.sort(
    (a, b) =>
      Number(a.disabledReason !== null) - Number(b.disabledReason !== null) ||
      a.label.localeCompare(b.label) ||
      a.destination.connectionId.localeCompare(b.destination.connectionId),
  );
  const seen = new Set<string>();
  return candidates.filter(({ profile }) => {
    const key = sshTargetKey(profile.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function findSavedSshWorktreeOption(
  options: ReadonlyArray<SavedSshWorktreeOption>,
  destination: DraftSshDestination | null | undefined,
): SavedSshWorktreeOption | null {
  if (!destination) return null;
  return (
    options.find(
      ({ destination: candidate }) =>
        candidate.connectionId === destination.connectionId &&
        candidate.environmentId === destination.environmentId,
    ) ?? null
  );
}
export function sshWorktreeSendBlockReason(input: {
  selected: boolean;
  draftAvailable: boolean;
  sourceIsPrimary: boolean;
  sourceProjectAvailable: boolean;
  sourceIsGitRepo: boolean;
  desktopAvailable: boolean;
  catalogReady: boolean;
  option: SavedSshWorktreeOption | null;
  canLaunch: boolean;
  hasAttachments: boolean;
  hasContextRecords: boolean;
  multipleModels: boolean;
}): string | null {
  if (!input.selected) return null;
  if (!input.draftAvailable) return "SSH worktrees need a new draft.";
  if (!input.desktopAvailable) return "SSH worktrees are available in the desktop app.";
  if (!input.sourceIsPrimary) return "Choose Local in Run on before sending to SSH.";
  if (!input.sourceProjectAvailable) return "Choose a local project before sending to SSH.";
  if (!input.sourceIsGitRepo) return "SSH worktrees need a Git project.";
  if (!input.catalogReady) return "Loading saved SSH connections.";
  if (!input.option) return "This saved SSH connection is unavailable. Choose another host.";
  if (input.option.disabledReason) return input.option.disabledReason;
  if (!input.canLaunch) return "This connection cannot copy code and start SSH threads.";
  if (input.multipleModels) return "Choose one model before sending to SSH.";
  if (input.hasAttachments) return "Remove attachments before sending to SSH.";
  if (input.hasContextRecords) return "Remove context chips before sending to SSH.";
  return null;
}
```

No network request or mutation occurs in this helper. Render-time options are memoized by entries and desktop availability. Re-read the atom synchronously at click/send to catch removal/disable/edit between rendering and action. Target changes on the same saved identity are resolved from that current profile; the draft never persists a stale SSH endpoint or credentials.

## 4. Shared menu, wide selector and label

### NEW apps/web/src/components/WorkspaceMenuItems.tsx

This is feature code, not a new generic UI primitive. Existing `MenuSubPopup` opens inline-end at `apps/web/src/components/ui/menu.tsx:320`. No new animation or polling.

```tsx
import type { DraftSshDestination } from "../composerDraftStore";
import type { SavedSshWorktreeOption } from "../lib/sshWorktree";
import type { EnvMode } from "./BranchToolbar.logic";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuItem,
} from "./ui/menu";

export interface WorkspaceMenuItemsProps {
  envMode: EnvMode;
  locked: boolean;
  forceNewWorktree: boolean;
  localLabel: string;
  sshDestination: DraftSshDestination | null;
  sshOptions: ReadonlyArray<SavedSshWorktreeOption>;
  sshDisabledReason: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onSshDestinationChange: (destination: DraftSshDestination) => void;
}
export function WorkspaceMenuItems(props: WorkspaceMenuItemsProps) {
  return (
    <MenuGroup>
      <MenuGroupLabel>Workspace</MenuGroupLabel>
      <MenuRadioGroup value={props.sshDestination ? "ssh" : props.envMode}>
        <MenuRadioItem
          value="local"
          closeOnClick
          disabled={props.locked || props.forceNewWorktree}
          onClick={() => props.onEnvModeChange("local")}
        >
          {props.localLabel}
        </MenuRadioItem>
        <MenuRadioItem
          value="worktree"
          closeOnClick
          disabled={props.locked}
          onClick={() => props.onEnvModeChange("worktree")}
        >
          New worktree
        </MenuRadioItem>
      </MenuRadioGroup>
      {props.sshOptions.length > 0 ? (
        <MenuSub>
          <MenuSubTrigger
            disabled={props.locked || props.forceNewWorktree || props.sshDisabledReason !== null}
            title={props.sshDisabledReason ?? undefined}
          >
            Worktree on SSH
          </MenuSubTrigger>
          <MenuSubPopup>
            {props.sshOptions.map((option) => (
              <MenuItem
                key={`${option.destination.environmentId}:${option.destination.connectionId}`}
                disabled={option.disabledReason !== null}
                closeOnClick
                title={option.disabledReason ?? undefined}
                onClick={() => props.onSshDestinationChange(option.destination)}
              >
                <span>{option.label}</span>
                {option.destination.connectionId === props.sshDestination?.connectionId &&
                option.destination.environmentId === props.sshDestination?.environmentId ? (
                  <span aria-label="Selected"> ✓</span>
                ) : null}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
    </MenuGroup>
  );
}
```

Both normal items use onClick rather than only onValueChange: choosing the already selected `worktree` value must clear SSH. Destination items are actions, not a third envMode radio value. Native menu keyboard activation invokes the same onClick. Keep local/worktree icons from the existing menu if desired; no UI component restyling is required by this design.

### MODIFY BranchToolbar.logic.ts

PR1 owns the general M1 label resolver at current `apps/web/src/components/BranchToolbar.logic.ts:97`, `:107`, `:113`. Add the following narrow wrapper and use it in both toolbar selectors:

```ts
export function resolveSshWorkspaceLabel(input: {
  workspaceLabel: string;
  sshSelected: boolean;
  savedLabel: string | null;
}): string {
  return input.sshSelected
    ? `Worktree · ${input.savedLabel ?? "unavailable SSH connection"}`
    : input.workspaceLabel;
}
```

Pending SSH always has mode text even with auto labels or multiple environments; the host comes from the selected saved profile. When unavailable, the placeholder label and Send reason disclose the stale selection. Non-SSH calls use PR1's label including any remote environment suffix. Tooltip exposes the full label when ComposerContextLabel truncates it (`apps/web/src/components/ComposerContextLabel.tsx:21`).

### MODIFY BranchToolbar.tsx

Anchors: props `:79`, RunContextSelector props `:141`, label `:193` / trigger text `:260`, Workspace menu `:365`, panel call `:715`, compact call `:771`, wide call `:819`, branch selector calls `:737` and `:846`.

Add this common prop group to BranchToolbarProps and RunContextSelectorProps, destructuring and forwarding at all three selector sites:

```ts
sshDestination?: DraftSshDestination | null;
sshOptions?: ReadonlyArray<SavedSshWorktreeOption>;
sshDisabledReason?: string | null;
onSshDestinationChange?: (destination: DraftSshDestination) => void;
```

Use null/empty defaults at the component boundary. RunContextSelector computes `selectedSshOption` using findSavedSshWorktreeOption. Wrap PR1's workspace label with resolveSshWorkspaceLabel; replace trigger's current environment/auto override at `:260` with this mode-first final label. Pending SSH has no current remote worktree path: tooltip must not claim local workspaceRoot is its destination path; show `Worktree · host` and the source path separately if panel context copy is retained.

Replace the complete Workspace MenuGroup at `:365` with:

```tsx
<WorkspaceMenuItems
  envMode={effectiveEnvMode}
  locked={envModeLocked}
  forceNewWorktree={forceNewWorktree}
  localLabel={resolveCurrentWorkspaceLabel(activeWorktreePath)}
  sshDestination={sshDestination ?? null}
  sshOptions={sshOptions ?? []}
  sshDisabledReason={sshDisabledReason ?? null}
  onEnvModeChange={onEnvModeChange}
  onSshDestinationChange={(destination) => onSshDestinationChange?.(destination)}
/>
```

The Run on portion remains the existing menu. Retain existing workspace/Run on disabled behavior. In this tree those controls use envLocked/envModeLocked (`BranchToolbar.tsx:333`, `:350`, `:377`, `:387`, `:641`), not isSendBusy; do not derive envLocked from a new submission flag. Preserve any already-wired isSendBusy disablement in the eventual PR2 base without extending it to composer content mutation guards. While merely selecting SSH, Run on remains available as the way out (its handler clears destination); disable BranchToolbarBranchSelector by passing `envLocked={envLocked || Boolean(sshDestination)}` to both panel and composer calls. Its automatic branch-selection effect and imperative `openBranchPicker` must honor pending SSH. This expansion is verified, not hypothetical: the effect at BranchToolbarBranchSelector.tsx:541 does not currently check envLocked, and imperative open at :572 only checks loading/action state. Apply the exact change below. Do not allow local branch/PR checkout side effects while a snapshot-of-current-HEAD destination is selected. The store still guards direct workspace mutations.

### MODIFY BranchToolbarBranchSelector.tsx

Verified anchors: draft metadata :140, setThreadBranch :176, canChangeThreadBranch :164, automatic base effect :541 and imperative open :572. Set `const sshSelected = draftThread?.sshDestination != null;`. Add `!sshSelected` to canChangeThreadBranch and early-return `if (sshSelected) return` in setThreadBranch, handleOpenChange when opening, and imperative open. Add sshSelected to their dependency arrays. At the automatic base effect insert `sshSelected ||` as its first guard and add sshSelected to dependencies. Unlike merely hiding a button, this stops the effect from clearing the destination by writing a local base branch.

Before / after automatic effect condition:

```ts
// before at :542:
if (
  effectiveEnvMode !== "worktree" ||
  activeWorktreePath ||
  activeThreadBranch ||
  !worktreeBaseBranchCandidate
)
  return;
// after:
if (
  sshSelected ||
  effectiveEnvMode !== "worktree" ||
  activeWorktreePath ||
  activeThreadBranch ||
  !worktreeBaseBranchCandidate
)
  return;
```

### MODIFY BranchToolbarEnvModeSelector.tsx

Current imports/UI use `Select` at `apps/web/src/components/BranchToolbarEnvModeSelector.tsx:14`, `:103`; locked display at `:69`. PR1 removes Previous worktree imports/options. Remove Select, SelectValue and ComposerSelectControl imports; use Menu, MenuTrigger, MenuPopup and ComposerControl. Extend props with the same destination/options/reason/callback group. Replace its open branch with this composition (retain existing icon, locked tooltip and context-menu mouse-down handling):

```tsx
<Menu>
  <Tooltip>
    <TooltipTrigger
      render={
        <MenuTrigger
          render={<ComposerControl size="xs" />}
          aria-label="Workspace"
          data-composer-shortcut="composer.workspace"
          data-composer-context-control
          onMouseDownCapture={stopContextMenuMouseDown}
        />
      }
    >
      {/* Keep PR1's opt-out (010 "collapseWhenCompact"): the mode label must stay readable at compact widths. */}
      <ComposerContextLabel collapseWhenCompact={false}>{workspaceLabel}</ComposerContextLabel>
    </TooltipTrigger>
    <TooltipPopup>{workspaceLabel}</TooltipPopup>
  </Tooltip>
  <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
    <WorkspaceMenuItems
      envMode={effectiveEnvMode}
      locked={envLocked}
      forceNewWorktree={forceNewWorktree}
      localLabel={resolveCurrentWorkspaceLabel(activeWorktreePath)}
      sshDestination={sshDestination ?? null}
      sshOptions={sshOptions ?? []}
      sshDisabledReason={sshDisabledReason ?? null}
      onEnvModeChange={onEnvModeChange}
      onSshDestinationChange={(destination) => onSshDestinationChange?.(destination)}
    />
  </MenuPopup>
</Menu>
```

Compute workspaceLabel with the same pending SSH wrapper. Do not retain a separate Select-only path at any breakpoint. Wrapper owns shrinking/layout; shared menu primitives keep their own appearance.

### MODIFY ThreadDetailsPanel.tsx

Current interface at `apps/web/src/components/chat/ThreadDetailsPanel.tsx:26`, branchToolbarProps at `:70` and workspace panel call at `:110`. Add the SSH prop group using `Pick<ComponentProps<typeof BranchToolbar>, "sshDestination" | "sshOptions" | "sshDisabledReason" | "onSshDestinationChange">` to the interface (or explicitly repeat the types), then forward it in branchToolbarProps. Context, Workspace panel and wide composer must not each invent catalog queries or host selection state.

## 5. NEW apps/web/src/lib/sshWorktreeSubmission.ts

Full new module; no RPC client import, React hooks, persisted receipts or launch retries. Commands are injected from ChatView's PR2 useAtomCommand binding. Wire input/result is defined in 020:115–143. Use the existing bounded waiter (`apps/web/src/state/entities.ts:201`, default 5,000 ms); no unbounded shell wait or polling loop.

```ts
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SshWorkspaceLaunchInput,
  SshWorkspaceLaunchResult,
} from "@t3tools/contracts";

type LaunchInput = SshWorkspaceLaunchInput;
type LaunchResult = SshWorkspaceLaunchResult;
export interface SshThreadOpenPorts {
  reconnect: (environmentId: EnvironmentId) => Promise<void>;
  waitForShell: (ref: ScopedThreadRef, timeoutMs: number) => Promise<boolean>;
  navigate: (ref: ScopedThreadRef) => Promise<void>;
}
export interface SshWorktreeSubmissionPorts extends SshThreadOpenPorts {
  launch: (target: { environmentId: EnvironmentId; input: LaunchInput }) => Promise<LaunchResult>;
  isSubmittedDraftContentUnchanged: () => boolean;
  deleteSubmittedDraft: () => void;
  emptySubmittedDraftContent: () => void;
}
export type SshWorktreeSubmissionOutcome =
  | { kind: "opened"; remoteRef: ScopedThreadRef }
  | { kind: "started-not-opened"; remoteRef: ScopedThreadRef; reason: string };
export class SshWorktreeNavigationError extends Error {
  constructor(
    readonly remoteRef: ScopedThreadRef,
    message: string,
  ) {
    super(message);
    this.name = "SshWorktreeNavigationError";
  }
}
export function remoteRefOf(result: LaunchResult): ScopedThreadRef {
  return scopeThreadRef(result.remoteEnvironmentId, result.remoteThreadId);
}
async function navigateToSshThread(
  input: { remoteRef: ScopedThreadRef; savedEnvironmentId: EnvironmentId },
  ports: Pick<SshThreadOpenPorts, "waitForShell" | "navigate">,
): Promise<void> {
  try {
    if (input.remoteRef.environmentId !== input.savedEnvironmentId) {
      throw new Error("The host returned a different environment. Check Settings → Connections.");
    }
    const routeRef = scopeThreadRef(input.savedEnvironmentId, input.remoteRef.threadId);
    if (!(await ports.waitForShell(routeRef, 5_000))) {
      throw new Error("The remote thread has not appeared in this saved connection yet.");
    }
    await ports.navigate(routeRef);
  } catch (error) {
    throw new SshWorktreeNavigationError(
      input.remoteRef,
      error instanceof Error ? error.message : "Could not open the remote thread.",
    );
  }
}
// Used only by the toast action: it has no launch or draft mutation capability.
export async function openSshThread(
  input: { remoteRef: ScopedThreadRef; savedEnvironmentId: EnvironmentId },
  ports: SshThreadOpenPorts,
): Promise<void> {
  try {
    await ports.reconnect(input.savedEnvironmentId);
    await navigateToSshThread(input, ports);
  } catch (error) {
    if (error instanceof SshWorktreeNavigationError) throw error;
    throw new SshWorktreeNavigationError(
      input.remoteRef,
      error instanceof Error ? error.message : "Could not connect to the saved environment.",
    );
  }
}
export async function submitSshWorktree(
  input: {
    sourceEnvironmentId: EnvironmentId;
    savedEnvironmentId: EnvironmentId;
    launchInput: LaunchInput;
  },
  ports: SshWorktreeSubmissionPorts,
): Promise<SshWorktreeSubmissionOutcome> {
  const result = await ports.launch({
    environmentId: input.sourceEnvironmentId,
    input: input.launchInput,
  });
  const remoteRef = remoteRefOf(result);
  // Navigate BEFORE deleting the draft: deleting the open draft unmounts ChatView and redirects to "/"
  // (apps/web/src/components/ThreadRouteView.tsx:137, :169), which would cancel this continuation.
  try {
    await navigateToSshThread({ remoteRef, savedEnvironmentId: input.savedEnvironmentId }, ports);
  } catch (error) {
    // Acknowledged launch, failed opening: report the reason to onSend, never swallow it.
    // Compare and clear synchronously, with no intervening await; changed content stays untouched.
    if (ports.isSubmittedDraftContentUnchanged()) ports.emptySubmittedDraftContent();
    const reason = error instanceof Error ? error.message : "Could not open the remote thread.";
    return { kind: "started-not-opened", remoteRef, reason: reason.slice(0, 500) };
  }
  // Navigation resolved first. New text, attachments or contexts preserve the ordinary draft.
  if (ports.isSubmittedDraftContentUnchanged()) ports.deleteSubmittedDraft();
  return { kind: "opened", remoteRef };
}
```

A transport loss after dispatch begins cannot prove no remote work started. Keep all current content and warn; do not infer safe retry from a disconnect. PR2 maps its dispatch error's launchMayHaveStarted to the wire code launch_uncertain (see [020 — SSH workspace service](020_phase2_ssh_workspace_service.md#ssh-workspace-service-complete-new-module), launch error mapping and dispatch flag propagation). Launch rejection propagates to onSend with all content intact. A positive launch response consumes content only if it still equals the captured snapshot: opened navigates first then deletes the unchanged draft, while started-not-opened clears only unchanged content and retains its session. Changed drafts remain entirely untouched for both outcomes, and started-not-opened still returns the bounded reason to the caller. The result/ref is transient; Open is available from the caller's toast, not persisted recovery metadata. Timeout, wait rejection, route change, identity mismatch and router rejection all produce started-not-opened, never a silent successful return.

## 6. ChatView integration and navigation ownership

### MODIFY ChatView.tsx — selection and guard

Bindings at `apps/web/src/components/ChatView.tsx:1617`–`:1670`: alias `vcsEnvironment.sshWorkspaceLaunch` as sshWorkspaceLaunchCommand and add PR2's launch command using `useAtomCommand(sshWorkspaceLaunchCommand, { reportFailure: false })`. Reuse `retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false })`; its input is the EnvironmentId itself.

Catalog: `useAtomValue(environmentCatalog.catalogValueAtom)` yields `{isReady, entries}`. Compute memoized options from `savedSshWorktreeOptions(entries, window.desktopBridge !== undefined)`. Read launch permission with `useAtomValue(sshWorkspaceLaunchCommand.permissionAtom(draftThread?.environmentId ?? null))`; that atom, not only canOperateThread, gates source-control write plus orchestration operate per 020/A7. Re-read via appAtomRegistry at send. Normal remote connection permission remains server/platform-owned.

### MODIFY ChatView.logic.ts — pure content comparison

Use `ComposerThreadDraftState` from `composerDraftStore.ts:388`–`:417`. Its content-only subset at `:389`–`:397` matches the fields cleared at `:4196`–`:4206`; provider/model/runtime/interaction and DraftSessionState workspace metadata are excluded. Snapshot exact raw prompt (no trim), ordered attachment IDs including hydration markers, and full structured context records so a changed record with the same ID is detected. The snapshot is an immutable string, not a reference to mutable arrays/File objects, and is captured only once per send and compared once at completion, never on every keystroke/render. Image/file/persisted-attachment bytes and preview URLs are not serialized by this helper; structured context records are compared in full.

```ts
import type { ComposerThreadDraftState } from "../composerDraftStore";

export function snapshotDraftContent(draft: ComposerThreadDraftState): string {
  return JSON.stringify({
    prompt: draft.prompt,
    images: draft.images.map(({ id }) => id),
    files: draft.files.map(({ id }) => id),
    nonPersistedImageIds: [...draft.nonPersistedImageIds],
    persistedAttachments: draft.persistedAttachments.map(({ id }) => id),
    terminalContexts: draft.terminalContexts,
    previewAnnotations: draft.previewAnnotations,
    reviewComments: draft.reviewComments,
    threadContexts: draft.threadContexts,
  });
}
export function isDraftContentUnchanged(
  snapshot: string,
  current: ComposerThreadDraftState | null | undefined,
): boolean {
  return current != null && snapshotDraftContent(current) === snapshot;
}
```

This compares current content, not a mutation counter: editing and restoring exactly the same content counts as unchanged. Reordering structured record keys can conservatively preserve an otherwise equivalent draft; it cannot erase added content. Missing/deleted content returns false and is never recreated. The plain-text launch guard rejects initial attachments/contexts, but the snapshot still covers all store content fields because any of them can be added during launch. Full preview/element, terminal, review and thread record comparison also protects programmatic context updates with stable IDs. No persistent field, schema version change beyond the SSH destination, serializer, remount-owned state or new guard is needed for this helper.

Add derived availability after the existing granular composer metadata selectors (ChatView.tsx:1798–1834), with catalog lookup after draftThread and activeProject are available. Import snapshotDraftContent/isDraftContentUnchanged from ChatView.logic; no submission state module is imported:

```ts
const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
const sshDestination = draftThread?.sshDestination ?? null;
const sshOptions = useMemo(
  () => savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
  [catalog.entries],
);
const selectedSshOption = findSavedSshWorktreeOption(sshOptions, sshDestination);
const canLaunchSsh = useAtomValue(
  sshWorkspaceLaunchCommand.permissionAtom(draftThread?.environmentId ?? null),
);
const sshSendBlockReason = sshWorktreeSendBlockReason({
  selected: sshDestination !== null,
  draftAvailable: isLocalDraftThread,
  sourceIsPrimary: draftThread?.environmentId === primaryEnvironmentId,
  sourceProjectAvailable: activeProject !== null,
  sourceIsGitRepo: isGitRepo,
  desktopAvailable: window.desktopBridge !== undefined,
  catalogReady: catalog.isReady,
  option: selectedSshOption,
  canLaunch: canLaunchSsh,
  hasAttachments: composerHasAttachments,
  hasContextRecords: composerHasNonPromptContent,
  multipleModels: multipleModelSelections !== null,
});
```

SendDisabledReason prioritizes `sshSendBlockReason ?? existingReason`. Use existing beginLocalDispatch/resetLocalDispatch to drive isSendBusy during the SSH continuation (`ChatView.tsx:896`–`:924`, `:3591`–`:3607`); retain the existing composer busy prop at `:11680` and synchronous sendInFlightRef guard at `:8836`. The composer content stays editable; no submission-derived envLocked, mutation guard or read-only prop is added. Menu-specific sshDisabledReason checks draft/local-source/Git/permission and multiple models only, allowing a host to be chosen before removing attachments. Re-read launch eligibility in onSend; completion safety comes from captured-ID content comparison, including across route changes/remounts. Existing per-instance busy/ref behavior does not promise duplicate-send exclusion across A→B→A or reload; do not reintroduce a lock to claim that guarantee.

Selection callback (place beside current onEnvModeChange at `:10848`):

```ts
const onSshDestinationChange = useCallback(
  (destination: DraftSshDestination) => {
    if (
      !draftId ||
      envLocked ||
      sendInFlightRef.current ||
      !activeProject ||
      activeProject.environmentId !== primaryEnvironmentId ||
      !isGitRepo ||
      multipleModelSelections !== null
    )
      return;
    const current = getDraftSession(draftId);
    if (!current) return;
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const option = findSavedSshWorktreeOption(
      savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
      destination,
    );
    if (
      !option ||
      option.disabledReason ||
      !appAtomRegistry.get(sshWorkspaceLaunchCommand.permissionAtom(current.environmentId))
    )
      return;
    setDraftThreadContext(draftId, {
      sshDestination: destination,
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
    scheduleComposerFocus();
  },
  [
    draftId,
    envLocked,
    activeProject,
    primaryEnvironmentId,
    isGitRepo,
    multipleModelSelections,
    getDraftSession,
    setDraftThreadContext,
    scheduleComposerFocus,
  ],
);
```

Selection need not require a prompt, attachments-free state or provider readiness; Send explains those restrictions later. Host submenu is disabled for non-drafts, nonlocal sources, non-Git source or denied permission, each with a reason. Multiple models disables host selection and retains a selected SSH destination if models are changed afterward so the Send guard can explain the conflict.

Add `sshDestination: null` to Local/New worktree writes at `:10857`, to onAutoEnvironment `:4427`, both Run on retarget calls `:4487`/`:4494`, and any work-locally fallback at `:10932`. Add `!draftThread?.sshDestination` to automaticEnvironment predicate at `:3048`; this also protects hydrated records. onStartFromOriginChange `:10945` returns immediately for pending SSH. Keep envLocked's existing definition at ChatView.tsx:3043–3045. Run on already checks sendInFlightRef before and after retarget preparation at `:4463`/`:4477`; keep those checks. Remove any repair-added submission lock reads/guards/derivations. Destination-selection invariants and the existing branch guard for a selected SSH snapshot source remain unrelated to composer content consumption.

Forward destination/options/reason/callback through `threadDetailsPanelProps` at `:11178` and composer BranchToolbar at `:11859`. No forwarding through settings or mobile.

### MODIFY ChatView.tsx — send path

Current `onSend` starts with busy/connection guards at `:8828`; sendCtx is read at `:8868`; source-local provider availability guard at `:8877`; fanout validation at `:8882`; normal base validation at `:9283`; first upload at `:9420`; local startThreadTurn at `:9969`.

SSH route must be handled immediately after sendCtx acquisition and pending-user-input handling, **before `!sendCtx?.providerAvailable` and multiple-model validation**. The remote validates provider execution availability. Allow selecting from the source model catalog, whose readiness is still required; bypass a source-specific provider send block when SSH is selected. PR2/remote validates the chosen provider/model. Do not invent a remote model fallback or dispatch NO_PROVIDER_MODEL_SELECTION when the source catalog has no configured choice.

Before:

```ts
if (!sendCtx?.providerAvailable) return;
// ... normal worktree and uploads ...
if (shouldCreateWorktree && !activeThreadBranch) {
  setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
  return;
}
```

After insertion (retain normal guards below unchanged for non-SSH). Retain onSend's existing isSendBusy/sendInFlightRef guard at `:8828`–`:8836`; add no per-DraftId lock check before slash-command or annotation mutation. Plain text only means use the trimmed prompt and existing formatOutgoingPrompt logic; do not drop inline records or send attachment IDs from the source. A standalone /plan or /default toggle keeps current local composer toggle semantics and does not launch a remote thread. All other prompt text, including provider-native slash commands, reaches initialMessage.

```ts
const sourceDraft = draftId ? getDraftSession(draftId) : null;
if (draftId && sourceDraft?.sshDestination) {
  if (!sendCtx) return;
  const capturedDraftId = draftId;
  const capturedContent = useComposerDraftStore.getState().getComposerDraft(capturedDraftId);
  if (!capturedContent) return;
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  const option = findSavedSshWorktreeOption(
    savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
    sourceDraft.sshDestination,
  );
  const blockReason = sshWorktreeSendBlockReason({
    selected: true,
    draftAvailable: true,
    sourceIsPrimary: sourceDraft.environmentId === primaryEnvironmentId,
    sourceProjectAvailable: activeProject !== null,
    sourceIsGitRepo: isGitRepo,
    desktopAvailable: window.desktopBridge !== undefined,
    catalogReady: catalog.isReady,
    option,
    canLaunch: appAtomRegistry.get(
      sshWorkspaceLaunchCommand.permissionAtom(sourceDraft.environmentId),
    ),
    hasAttachments:
      capturedContent.images.length > 0 ||
      capturedContent.files.length > 0 ||
      capturedContent.nonPersistedImageIds.length > 0 ||
      capturedContent.persistedAttachments.length > 0 ||
      directAnnotation?.image !== undefined,
    hasContextRecords:
      capturedContent.terminalContexts.length > 0 ||
      capturedContent.previewAnnotations.length > 0 ||
      capturedContent.reviewComments.length > 0 ||
      capturedContent.threadContexts.length > 0 ||
      directAnnotation !== undefined,
    multipleModels: sendCtx.multipleModelSelections !== null,
  });
  if (blockReason) {
    setThreadError(sourceDraft.threadId, blockReason);
    return;
  }
  if (!option) return; // type narrowing; prior guard gives the visible reason.
  const text = capturedContent.prompt.trim(); // same raw prompt used by the content snapshot
  if (!text) return;
  // Preserve the existing standalone interaction-mode toggle before launching.
  const standalone = sendCtx.interactionModeEnabled
    ? parseStandaloneComposerSlashCommand(text)
    : null;
  if (standalone) {
    handleInteractionModeChange(standalone);
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();
    return;
  }
  const outgoingText = formatOutgoingPrompt({
    provider: sendCtx.selectedProvider,
    model: sendCtx.selectedModel,
    models: sendCtx.selectedProviderModels,
    effort: sendCtx.selectedPromptEffort,
    text,
  });
  if (composerRef.current?.validateProviderInput(outgoingText) === false) return;
  const capturedSavedDestination = option.destination;
  const capturedHostLabel = option.label;
  const capturedRouteThreadKey = routeThreadKey;
  // Capture raw current content independently of outgoingText formatting, before any await.
  const submittedContentSnapshot = snapshotDraftContent(capturedContent);
  sendInFlightRef.current = true;
  beginLocalDispatch({ preparingWorktree: false, submissionIntent });
  let sshLaunchDispatchBegan = false;
  try {
    const outcome = await submitSshWorktree(
      {
        sourceEnvironmentId: sourceDraft.environmentId,
        savedEnvironmentId: option.destination.environmentId,
        launchInput: {
          sourceProjectId: sourceDraft.projectId,
          destination: {
            connectionId: option.destination.connectionId,
            expectedEnvironmentId: option.destination.environmentId,
            target: option.profile.target,
          },
          title: text.slice(0, 80),
          modelSelection: sendCtx.selectedModelSelection,
          runtimeMode,
          interactionMode: sendCtx.interactionMode,
          initialMessage: { text: outgoingText },
        },
      },
      makeSshSubmissionPorts(
        capturedDraftId,
        submittedContentSnapshot,
        capturedSavedDestination,
        capturedRouteThreadKey,
        () => {
          sshLaunchDispatchBegan = true;
        },
      ),
    );
    if (outcome.kind === "started-not-opened") {
      showSshStartedNotOpened(outcome, {
        destination: capturedSavedDestination,
        hostLabel: capturedHostLabel,
      }); // caller owns the toast and its connect-only Open thread action
    }
  } catch (error) {
    showSshSubmissionError(error, sourceDraft, option, { dispatchBegan: sshLaunchDispatchBegan });
  } finally {
    sendInFlightRef.current = false;
    resetLocalDispatch();
  }
  return; // SSH must never fall through to normal startThreadTurn.
}
```

The port factories are local functions in ChatView, not service wrappers. Import SshThreadOpenPorts/SshWorktreeSubmissionPorts from the new submission module and DraftSshDestination from the draft store. Keep the connect-only factory separate so the toast closure captures no DraftId, launch port or draft mutation port. A null automaticRouteKey means an explicit Open action; the initial send captures the source route key before awaiting:

```ts
const makeSshThreadOpenPorts = (
  savedDestination: DraftSshDestination,
  automaticRouteKey: string | null,
): SshThreadOpenPorts => ({
  reconnect: async (savedEnvironmentId) => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const option = findSavedSshWorktreeOption(
      savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
      savedDestination,
    );
    if (
      !catalog.isReady ||
      !option ||
      option.disabledReason ||
      savedEnvironmentId !== savedDestination.environmentId
    ) {
      throw new Error("This saved SSH connection is unavailable. Check Settings → Connections.");
    }
    const result = await retryEnvironment(savedEnvironmentId);
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  },
  waitForShell: waitForThreadShell,
  navigate: async (remoteRef) => {
    if (automaticRouteKey !== null && currentRouteThreadKeyRef.current !== automaticRouteKey) {
      throw new Error("The remote thread started. Use Open thread when ready.");
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(remoteRef),
      replace: true,
    });
  },
});
const makeSshSubmissionPorts = (
  capturedDraftId: DraftId,
  submittedContentSnapshot: string,
  savedDestination: DraftSshDestination,
  capturedRouteThreadKey: string,
  onDispatchBegan: () => void,
): SshWorktreeSubmissionPorts => {
  return {
    ...makeSshThreadOpenPorts(savedDestination, capturedRouteThreadKey),
    launch: async (target) => {
      onDispatchBegan();
      const result = await launchSshWorkspace(target);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    // Always re-read by captured ID, including after route changes or remounts.
    isSubmittedDraftContentUnchanged: () =>
      isDraftContentUnchanged(
        submittedContentSnapshot,
        useComposerDraftStore.getState().getComposerDraft(capturedDraftId),
      ),
    // Called synchronously after an unchanged-content comparison and successful navigation.
    deleteSubmittedDraft: () => clearDraftThread(capturedDraftId),
    // Called when navigation did not happen (timeout, route changed, identity mismatch): the draft
    // session stays so its route stays mounted. Called only when content still matches the
    // snapshot; remove it through the existing selector alias, never the displayed target.
    emptySubmittedDraftContent: () => {
      clearComposerDraftContent(capturedDraftId); // ChatView.tsx:1833 → composerDraftStore.ts:4186
      if (currentRouteThreadKeyRef.current === capturedRouteThreadKey) {
        promptRef.current = "";
        composerRef.current?.resetCursorState();
      }
    },
  };
};
```

Capture DraftId, immutable content snapshot, source IDs, saved connection identity/label and route key before awaits. Both outgoing text and the content snapshot read capturedContent.prompt, then the wire text uses the existing trim/formatOutgoingPrompt transformation. Do not snapshot trimmed/formatted output or compare against a stale render/promptRef value. Live attachment/context guards read the same captured store content before dispatch. Add clearDraftThread beside the existing selectors at `ChatView.tsx:1833`. Each successful navigation is followed by a fresh captured-ID content read and synchronous comparison/deletion, without an await between comparison and mutation. An opened outcome is independent of consumption: changed content leaves the source as an ordinary draft visible in the sidebar after navigating to the remote thread.

If opening fails or the user changed route, return started-not-opened and perform the same fresh comparison immediately before clearComposerDraftContent. Unchanged content clears via `composerDraftStore.ts:4186`–`:4214` while source metadata/destination/session/mapping remain; changed content, promptRef and cursor are all untouched. The caller shows Open thread either way. `currentRouteThreadKeyRef` at `ChatView.tsx:1598` and its cleanup at `:1602` guard only automatic navigation and resetting the old instance's promptRef/cursor, not content comparison. A→B→A remounts A editable: the old ref is null so its completion returns started-not-opened, then reads A's live content by captured ID; changes on remounted A are preserved, and B is never mutated. The new instance derives its editor content from the actual store. No external submission state or remount lock remains.

### Errors and Open thread toast

Failure before acknowledgement keeps the entire current draft, including content added during launch, destination and mapping; finally resets existing busy state only. Implement `showSshSubmissionError` using existing setThreadError and toastManager/stackedThreadToast. Preserve typed code/stage through squashAtomCommandFailure; do not classify a typed error by its prose. Map every SshWorkspaceCode exhaustively (see [020 — Contracts: new complete module](020_phase2_ssh_workspace_service.md#contracts-new-complete-module)), e.g. `satisfies Record<SshWorkspaceCode, string>`. Substitute the captured saved label for `<host>`:

| Code                      | User copy                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `invalid_target`          | This saved SSH target is invalid. Choose another host or update Connections.                            |
| `project_not_found`       | The local project no longer exists. Choose a local project.                                             |
| `not_git_repository`      | SSH worktrees need a Git project.                                                                       |
| `project_not_repo_root`   | Choose the repository root as the local project before sending to SSH.                                  |
| `project_read_failed`     | Could not read the local project. Check access before sending again.                                    |
| `host_unavailable`        | Could not reach &lt;host&gt;. Check its SSH connection before sending again.                            |
| `remote_unsupported`      | &lt;host&gt; needs an updated server to start SSH worktrees.                                            |
| `model_unavailable`       | The selected model is unavailable on &lt;host&gt;. Choose a supported model.                            |
| `environment_mismatch`    | &lt;host&gt; returned a different environment. Check Settings → Connections.                            |
| `invalid_remote_response` | &lt;host&gt; returned an invalid response. Check its server before sending again.                       |
| `snapshot_failed`         | Could not snapshot this project. Check the project before sending again.                                |
| `unsupported_snapshot`    | This repository cannot be copied as an SSH snapshot.                                                    |
| `head_changed`            | The local HEAD changed during the snapshot. Review the project before sending again.                    |
| `secret_candidate`        | Early warning: untracked credential-like files were found. Review the named files before sending.       |
| `foreign_path`            | The remote path is not owned by this SSH workspace. Choose another destination.                         |
| `remote_init_failed`      | Could not prepare the workspace on &lt;host&gt;. Check its access and available space.                  |
| `push_failed`             | Could not copy the snapshot to &lt;host&gt;. Check the SSH connection and repository.                   |
| `push_ref_conflict`       | The snapshot reference already exists on &lt;host&gt;. Check the remote workspace before sending again. |
| `push_oid_mismatch`       | The snapshot on &lt;host&gt; does not match the local snapshot. Check the remote workspace.             |
| `launch_refused`          | &lt;host&gt; refused to start the thread. Check its model and permissions.                              |
| `launch_uncertain`        | The thread may already have started on &lt;host&gt;; check its threads before sending again.            |
| `invalid_branch`          | The remote branch is invalid. Choose a valid workspace branch.                                          |
| `source_not_found`        | Could not find the local source project for this remote workspace.                                      |
| `source_ambiguous`        | More than one local source project matches this remote workspace. Resolve the duplicate projects.       |
| `fetch_failed`            | Could not fetch the remote changes. Check the SSH connection and repository.                            |

Fetch-only codes are included for exhaustive contract coverage; PR3 does not invoke fetchBack. For secret_candidate show only bounded fileNames and this early-warning copy (M4), without a bypass switch. Add host/stage/code as bounded context; never show credentials or raw shell output. A structured EnvironmentAuthorizationError uses permission-denied copy and retains content; it is not a reconnect loop.

Uncertainty takes priority over ordinary error copy: `launch_uncertain`, an available dispatch error with `launchMayHaveStarted === true`, or an untyped interruption/transport loss after launch RPC invocation began must keep all current content and show warning `The thread may already have started on <host>; check its threads before sending again.` A generic failure before dispatch began says `Could not send to <host>. Your draft was kept.` No automatic retry, resend action, receipt, readOperation or new operationId. Track the dispatch-began boundary in the launch port, not from an error's message. PR2 launch_refused is a definitive remote refusal; users may explicitly send again after resolving it.

onSend must handle the started-not-opened outcome explicitly through showSshStartedNotOpened, rather than expecting submitSshWorktree to throw SshWorktreeNavigationError. At that point unchanged submitted content is empty, or changed content is intact; the session/mapping remains in either case. Report the returned reason by toast only and show Open thread in both cases. The helper uses toastManager/stackedThreadToast to show exactly `Started on <host>, but could not open the thread`, the returned thread ID and bounded reason, with `actionProps: { children: "Open thread", onClick }` (`apps/web/src/components/ChatView.tsx:9667`). Capture remoteRef, saved destination identity and host label only. onClick calls openSshThread({remoteRef, savedEnvironmentId: destination.environmentId}, makeSshThreadOpenPorts(destination, null)); these ports contain only reconnect/waitForShell/navigate, with no launch or draft mutation. Re-resolve the saved connection and reject deleted/disabled entries before reconnecting; connect using retryNow, wait at most 5,000 ms, then navigate(replace) using buildThreadRouteParams. Open failure (SshWorktreeNavigationError) retains/replaces the toast with its Open thread action and bounded error. Open success leaves the source draft alone, whether empty or changed; the action has no draft mutation capability. It stays usable after route changes and depends on no draft lookup.

Identity mismatch still gets this action: reconnect the saved environment, then validate the captured result identity before waiting/navigating. If mismatch remains, show the Connections guidance and keep host/thread identifiers; never manufacture a route for a thread on the wrong environment. An inactive connection gets the normal timeout action. The ordinary source session, empty or changed, may survive normal draft persistence, but no remote ref, outcome, receipt or Open action survives reload; the launched thread remains owned by its remote server.

Render sshSendBlockReason in sendDisabledReason at `:11683`. Add `sshWorktreeSelected={draftThread?.sshDestination != null}` to ChatComposer at `:11670`. Keep existing isSendBusy prop wiring at `:11680`; beginLocalDispatch/resetLocalDispatch bracket the launch/open continuation and finally reset the existing ref/busy state. The send guard/ref handles duplicate activation in the mounted instance; no remount-wide exclusion is claimed. Source connection readiness still applies because launch originates there. Keep the captured session intact while waiting/navigating, then consume only unchanged content.

### MODIFY chat/ChatComposer.tsx

Current props at :1545, destructuring at :1729, providerSendBlockReason at :2197, button/keyboard blocking at :2201/:4234 and getSendContext.providerAvailable at :6625 were read. Add optional `sshWorktreeSelected?: boolean` to ChatComposerProps and destructure with default false. Before / after:

```ts
// before at :2197:
const providerSendBlockReason = getAntigravitySendBlockReason(
  selectedProviderEntry?.snapshot,
  selectedModel,
);
// after:
const providerSendBlockReason = sshWorktreeSelected
  ? null
  : getAntigravitySendBlockReason(selectedProviderEntry?.snapshot, selectedModel);
```

All existing sendDisabledReason consumers now get the parent SSH guards and skip only the source-specific provider block. Keep noProviderAvailable checks at :3043/:4203/:4234/:6964/:7658/:7748: the user still needs a model from the source catalog, and a missing configured choice cannot become a remote placeholder provider. getSendContext continues reporting its existing model/provider fields; the SSH branch handles the remote-specific execution check. No mobile/native prop forwarding is needed because this is the shared web/Electron component. Compact-context commands are unaffected.

### Content-revision consumption — changed-plan audit disposition

After three failed audit rounds, main rejected the transient DraftId submission lock and the expanding composer mutation-guard approach (LOOP-REPAIR-01: changed plan). Remove the proposed state/sshWorktreeSubmission.ts module, every guard/read-only path/envLocked derivation added for it, and their lock-only tests. The composer remains editable throughout launch, shell wait and navigation. Preserve existing isSendBusy send-button behavior (`ChatComposer.tsx:3040`, `:4200`, `:4344`) and model trigger behavior (`:5569`); the editor's existing disabled expression at `:7630`–`:7635` does not include isSendBusy. Do not add a read-only prop or guard typing, paste, history, mentions, file drops, model shortcuts or imperative context insertion for SSH.

Every composer content mutation path is safe for completion consumption because it changes a field covered by the snapshot comparison: typing/paste change prompt; attachments change images/files/hydration IDs; context insertion changes terminalContexts, previewAnnotations (element contexts), reviewComments or threadContexts. Desktop capture bypasses component callbacks through `apps/web/src/components/desktop/SnapShotCoordinator.tsx:141`–`:180`: read/compress awaits precede direct store.addImage and persisted-attachment synchronization. Do not guard or edit that coordinator. A simulated capture/addImage during a deferred launch must make the comparison false and preserve the entire draft, including its original submitted text and the new image, for both opened and started-not-opened. This protects additions instead of preventing them.

Completion rules are explicit: opened navigates first, deletes the captured draft only when unchanged, and leaves a changed draft as an ordinary sidebar draft; started-not-opened clears unchanged content only and always retains session/mapping plus the caller's Open thread toast; launch failure/launch_uncertain never consume content and show error/warning. Open reconnects/waits/navigates only, with no launch or draft mutation capability. No SSH promotion, remote-ref draft lookup, ThreadRouteView opt-out, explicitNavigationPending field or Sidebar edit is planned. Existing selected-SSH branch/source invariants remain; they are unrelated to the withdrawn submission lock. This amendment is implementation guidance and requires a fresh parent-owned audit, not a PASS claim.

## PLAN-FIELD-CHAIN-01 ledger

| Value                                                                            | Creation                                                                                                              | Serialization                                                                                                      | Deserialization                                                                                            | Consumers / removal                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sshDestination.connectionId`                                                    | Saved SSH profile selected by catalog helper, then draft setter/factory options                                       | Optional nullable DraftSshDestinationSchema in PersistedDraftThreadState; partializer stores draft field; JSON v10 | legacy/current normalize; malformed non-null identity becomes unavailable sentinel; hydrator copies        | Catalog identity lookup on render/send; full profile resolved live for launch; Local/New worktree/Run on/new-thread reset clear; opened deletes captured draft after navigation only if content is unchanged; started-not-opened preserves destination/session/mapping and clears unchanged content only; both leave changed drafts untouched.        |
| `sshDestination.environmentId`                                                   | Saved profile's containing environment, checked against profile                                                       | Same schema; branded EnvironmentId                                                                                 | Same normalizer/hydrator; missing legacy field null                                                        | Expected remote identity passed to server; response checked; scoped remote navigation uses saved identity. Never overwrites source draft.environmentId.                                                                                                                                                                                               |
| `envMode=worktree`, `worktreePath=null`, `startFromOrigin=false`, manual routing | SSH select explicitly writes these existing fields                                                                    | Existing persisted fields; resolver enforces SSH invariant                                                         | Legacy/current normalized SSH enforces tuple and manual route                                              | Existing Git consumers retain two modes; SSH send bypasses base selection; load balancing and branch controls cannot mutate source.                                                                                                                                                                                                                   |
| Saved option label/target/disabled reason                                        | Read from saved current profile and entry, derived once per catalog update                                            | N/A: derived from existing catalog; never stored in new draft fields                                               | Existing catalog decoder owns profiles; N/A for new storage                                                | Menu, pending label, input target and error copy; current profile re-read at execution.                                                                                                                                                                                                                                                               |
| Captured DraftId / content snapshot / dispatch-began flag                        | onSend captures ID and snapshotDraftContent(current captured draft) before awaits; launch port sets dispatch boundary | N/A: immutable per-send closure values, not a store/receipt or persisted field                                     | N/A: no reload recovery; closure survives pending async completion and re-reads actual store after remount | isDraftContentUnchanged(snapshot, current captured-ID content) in ChatView.logic controls synchronous conditional delete/clear; prompt, image/file/persisted/hydration IDs and all contexts covered; changed draft untouched. Missing content returns false. Dispatch flag selects transport-loss warning; existing local busy/ref resets in finally. |
| Unavailable identity sentinel                                                    | Only malformed persisted non-null SSH identity                                                                        | Normal optional destination field after migration                                                                  | Same destination shape on later reload                                                                     | Missing catalog option visibly blocks; reselection/reset removes. No actual target or RPC dispatch.                                                                                                                                                                                                                                                   |
| Transient outcome / remote ref / saved identity                                  | Positive launch response and captured saved connection; opened or started-not-opened with bounded reason              | N/A: caller/toast closure only, no recovery storage                                                                | N/A: does not survive reload                                                                               | Launch → bounded shell wait → saved route navigate(replace) → opened conditionally deletes unchanged captured draft; failed opening returns started-not-opened after conditional unchanged-content clear, keeps session and prompts caller's Open regardless of content changes; Open reconnects/waits/navigates without launch or draft mutation.    |
| Wire launch input/result                                                         | Input assembled from source project/current saved profile + composer                                                  | PR2's contract/RPC command encoder                                                                                 | PR2's RPC decoder                                                                                          | submitSshWorktree; remoteRefOf; PR2 service owns server-side IDs/path/ref/scripts. N/A for PR3 contract edits.                                                                                                                                                                                                                                        |

Fetch-back provenance is not a new PR3 receipt: PR4 uses the remote project's current workspaceRoot/branch plus saved target, and the local server resolves the matching source project as A13 requires. The transient launch result is not made a second persisted job record.

## Tests and reachable activation (C-ACTIVATION-GROUNDING-01)

Use existing Vitest/jsdom patterns, not static markup assertions. Existing `BranchToolbar.panel.test.tsx:1` uses jsdom/createRoot/act and real menu clicks. Submission tests use the **real draft store and pure content comparator** with deferred fake command/shell/navigation promises, asserting current-content retention on failure, conditional deletion after navigation, conditional content-only clearing with session/mapping retention, caller toast for changed and unchanged drafts, and editable remount preservation. Do not sleep or poll. New helper tests are meaningful route/error behavior, not assertions that callbacks were merely wired.

| Exact test file                                          | Named case to add                                                                         | Activation / observable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/composerDraftStore.test.ts`                | `round-trips an SSH destination through partialize and hydrate`                           | Select host, serialize/rehydrate actual persisted state; source IDs and host IDs remain distinct.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| same                                                     | `hydrates v9 drafts without an SSH destination`                                           | Legacy stored draft missing field still uses existing local/worktree behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| same                                                     | `retains malformed SSH intent as an unavailable destination`                              | Non-null invalid identity/incompatible workspace tuple; restore prompt, block catalog lookup, no ordinary launch fallback.                                                                                                                                                                                                                                                                                                                                                                                               |
| same                                                     | `updates only the SSH destination when choosing another host`                             | Same worktree tuple, different connection ID triggers equality change.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| same                                                     | `clears SSH on workspace or source project changes`                                       | Parameterized Local, New worktree, manual branch/path/origin, project/environment retarget; no destination remains.                                                                                                                                                                                                                                                                                                                                                                                                      |
| same                                                     | `preserves SSH during runtime and model changes`                                          | Runtime/interaction update has no workspace key; full destination retained.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/hooks/useHandleNewThread.test.ts`          | `resets a reused empty SSH draft to the resolved project default`                         | New-thread action on already-open SSH draft; null destination, Local built-in, or configured worktree default per A1.                                                                                                                                                                                                                                                                                                                                                                                                    |
| same                                                     | `keeps an invested SSH draft when minting a fresh draft`                                  | Prompt-bearing draft survives mapped/unmapped; new one has null destination.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| same                                                     | `does not clear the concurrently registered winner's SSH destination`                     | Defer default read, register winner with explicit SSH choice, resolve first request; race protections retain winner.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/lib/sshWorktree.test.ts`                   | `includes saved alternate SSH routes but excludes discovered or bearer-only hosts`        | Preferred direct/relay route with alternate SshConnectionProfile; only saved SSH becomes option.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| same                                                     | `deduplicates full SSH targets while preserving distinct user and port`                   | Alias/host/user/port duplicate, enabled beats disabled; differing user/port remain separate.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| same                                                     | `lists disabled and outdated saved connections with reasons`                              | enabled=false / unsupportedReason entry; present but not launchable.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| same                                                     | `hides the entry for an empty browser catalog`                                            | Empty/bearer-only map returns zero; no discovery request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| same                                                     | `rejects a stale browser SSH profile without desktop transport`                           | Imported saved profile + desktopAvailable=false; disabled reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| same                                                     | `reports each SSH guard at its reachable activation`                                      | Table cases for missing draft; no desktop; remote source; deleted source project; non-Git source; catalog loading; host removed; host disabled/unsupported; permission denied; multipleModels including []; images/files incl hydration marker; context records. Assert exact reason and zero launch attempts.                                                                                                                                                                                                           |
| same                                                     | `ignores SSH guards when no destination is selected`                                      | Selected=false with all invalid inputs leaves ordinary send unblocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/src/components/BranchToolbar.logic.test.ts`    | `shows the saved SSH label before transfer`                                               | Worktree · saved label independent of source machine/auto label.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| same                                                     | `shows unavailable SSH rather than a local worktree after profile removal`                | selected=true, savedLabel=null; stale destination still explicit.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web/src/components/BranchToolbar.panel.test.tsx`   | `selects a saved SSH host through the right submenu at every layout`                      | Render compact RunContextSelector, panel and wide BranchToolbarEnvModeSelector with jsdom; activate menus and submenu by click/ArrowRight/Enter; actual store tuple changes, source IDs stay local.                                                                                                                                                                                                                                                                                                                      |
| same                                                     | `does not auto-pick a local base branch while SSH is selected`                            | Pending SSH with null branch and loaded default refs; mount real branch selector with dependency mocks, flush effects; destination stays selected and branch remains null; imperative branch keybinding cannot open it.                                                                                                                                                                                                                                                                                                  |
| same                                                     | `clears SSH when New worktree is clicked again`                                           | Pending SSH + worktree mode; click New worktree; destination null even same mode.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| same                                                     | `keeps disabled hosts visible and nonactivatable`                                         | Disabled saved item; keyboard/click cannot mutate draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| same                                                     | `hides Worktree on SSH when no saved SSH route exists`                                    | All three layouts, no submenu DOM item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| same                                                     | `locks SSH for a server thread, remote source, multiple models or denied write grant`     | Concrete props/state for each guard; disabled selector with reason, unchanged draft.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/src/components/chat/ChatComposer.ssh.test.tsx` | `allows an SSH send with a source-specific provider block`                                | Mount real ChatComposer with configured selected model and local Antigravity block; set sshWorktreeSelected; button/keyboard reach onSend, ordinary mode still blocks.                                                                                                                                                                                                                                                                                                                                                   |
| same                                                     | `keeps typing and paste editable during SSH launch`                                       | Defer launch with real editor mounted and existing isSendBusy active; type/paste update the real draft while send controls remain busy. No SSH aria-readonly/contenteditable=false is introduced; existing non-SSH editor-disabled conditions still apply. Completion comparison observes changes and never clears them. Preserve the already-busy model trigger; add no model mutation guards.                                                                                                                          |
| same                                                     | `keeps SSH attachments, fanout and absent model choice blocked`                           | Parent SSH disabled reason for attachments/fanout and noProviderAvailable with no source choice; button/keyboard dispatch nothing and show reason.                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/ChatView.logic.test.ts`         | `compares all composer content fields without retaining mutable references`               | Equal clones return true; exact prompt whitespace change, image/file/persisted/hydration ID add/remove/reorder, each terminal/preview-element/review/thread context add/remove/edit (including same-ID edits) return false. Capture, mutate original arrays and verify snapshot stays fixed. Missing current returns false; model/runtime/workspace-only changes do not alter content equality; edit-and-restore exact content returns true.                                                                             |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `preserves content added during launch by simulated desktop capture addImage`             | Start plain-text SSH launch with real store and deferred command, then call store.addImage(capturedDraftId, captureImage) as SnapShotCoordinator.tsx:141–180 does, optionally syncPersistedAttachments. Parameterize opened/started-not-opened: image and original prompt/session/mapping survive, no clearDraftThread/clearComposerDraftContent; opened navigates first and draft still qualifies as an ordinary Sidebar row; started-not-opened shows Open thread. No capture-coordinator mutation guard is installed. |
| same                                                     | `preserves text and contexts added during shell wait or navigation`                       | Parameterize typed/pasted text and terminal/preview-element/review/thread records while launch/shell/router deferred. Opened still navigates, then changed draft survives; started-not-opened preserves full draft and gets Open toast. Completion reads after navigation, not a stale render snapshot.                                                                                                                                                                                                                  |
| `apps/web/src/lib/sshWorktreeSubmission.test.ts`         | `returns opened after navigation and consumes only unchanged content`                     | Parameterize unchanged/changed content. Source RPC stays local; launch(source) → waitForThreadShell(saved, 5,000 ms) → navigate(saved environment/returned thread, replace) resolves → fresh compare → clearDraftThread(captured DraftId) only if unchanged. Session/content/mapping remain during shell/router awaits. Changed content survives as an ordinary draft. Both cases return {kind: "opened", remoteRef}; no promotion.                                                                                      |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `deletes an unchanged submitted draft only after remote navigation succeeds`              | Defer launch, shell and router separately with real ThreadRouteView/ChatView lifecycle. Session stays mounted and editor stays editable through each await; navigate uses saved environment/returned thread with replace=true. Only navigation resolution plus unchanged comparison removes session/content/mapping. No redirect to `/` during shell wait; finally resets existing busy/ref.                                                                                                                             |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `never calls normal launch or uploads for SSH send`                                       | Mount real ChatView and activate its onSend path with spies on normal startThreadTurn/upload; SSH launch once, others zero, including null base branch. Do not test a copied/extracted stand-in for the integration branch.                                                                                                                                                                                                                                                                                              |
| same                                                     | `keeps the entire current draft when launch fails at each stage`                          | PR2 typed definite errors at each launch stage; add newer text/context while launch is pending and assert all current content/destination/session/mapping unchanged. Finally resets existing busy/ref; exact code copy and host/stage visible. All 25 codes covered by formatter cases (fetch-only cases never invoke launch); launch_uncertain has its warning case below.                                                                                                                                              |
| same                                                     | `reports an uncertain launch without automatic retry`                                     | launch_uncertain/launchMayHaveStarted or transport loss after dispatch began; add content during launch, assert entire current draft preserved and editor editable, exact may-already-have-started warning names host, launch count stays one; finally resets busy/ref.                                                                                                                                                                                                                                                  |
| `apps/web/src/lib/sshWorktreeSubmission.test.ts`         | `returns started-not-opened and consumes only unchanged content for each opening failure` | Parameterize timeout=false at explicit 5,000-ms bound, wait rejection, route-change rejection, identity mismatch and router rejection, each with unchanged/changed content. Outcome includes remoteRef and bounded reason; unchanged captured-ID content clears but session/mapping/destination remain; changed draft is entirely untouched; neither deletes. Identity mismatch performs no shell/router call on wrong environment. Launch rejection throws before comparison/mutation.                                  |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `shows Open thread after navigation timeout for unchanged and changed drafts`             | Launch succeeds, bounded waiter returns false. Unchanged captured content clears via clearComposerDraftContent; typed/added content stays untouched in changed case. Both retain session/mapping and get the exact Started on <host>, but could not open the thread toast + Open thread. Action reconnects/waits/navigates after route change, never launches or mutates source draft; launch count one, finally resets existing busy/ref.                                                                               |
| same                                                     | `keeps the ordinary session and Open action when opening keeps failing`                   | Wait throws/router rejects, then action reconnect fails or saved entry is deleted/disabled. Unchanged content has cleared, changed content is retained; ordinary session/mapping and actionable toast remain in both cases, with no restoration, draft mutation from Open or launch retry.                                                                                                                                                                                                                               |
| same                                                     | `reports started-not-opened for a mismatched saved environment`                           | Response differs from saved ID: initial attempt conditionally clears only unchanged captured content, preserves changed content/session/mapping, and caller always shows host/thread ID/reason + Open. Action reconnects saved environment, validates identity again, never waits/navigates on wrong environment or relaunches.                                                                                                                                                                                          |
| same                                                     | `keeps a newer draft untouched after navigation away`                                     | Deferred A launch, route moves to B and B gets newer content; acknowledge A, finish bounded wait: route guard returns started-not-opened. Compare A by captured ID; unchanged A clears content only, changed A stays intact. B remains editable and unchanged. Caller shows Open either way; no forced route or second launch.                                                                                                                                                                                           |
| same                                                     | `preserves content added on A after A→B→A during a deferred launch`                       | Mount/send A, navigate to B and type content, remount A and type/paste/insert context before resolving launch. A stays editable, B stays intact. Old route ref is null so completion returns started-not-opened; live captured-ID comparison sees changed A and leaves its content/session/mapping intact; caller shows Open. Parameterize definite failure/launch_uncertain to preserve all additions and show correct error/warning. No remount lock or duplicate-send exclusion assertion.                            |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `serializes duplicate send activation in the mounted instance`                            | Double keyboard/click activation before deferred launch resolves; existing synchronous sendInFlightRef and isSendBusy produce one RPC. No exclusion guarantee across remount/reload is asserted.                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/ChatView.ssh.test.tsx`          | `rejects attachments, context and fanout before command dispatch`                         | Send snapshots include image/file/direct annotation/context or multiple selections; reason matches visible disabled control, no source upload/local launch.                                                                                                                                                                                                                                                                                                                                                              |
| same                                                     | `requires a new explicit send after a definitive prelaunch failure`                       | Failed launch resolves; finally clears busy; explicit next activation allowed; no scheduled retry.                                                                                                                                                                                                                                                                                                                                                                                                                       |

The ChatView.ssh.test.tsx fixture mounts real ChatView with real composerDraftStore and mocks connection/provider/UI dependencies, then activates its actual composer onSend handler. Navigation/deletion and A→B→A cases retain real ThreadRouteView lifecycle so early deletion, editable remounts and current-store comparisons are observable; control router navigation with a Deferred promise. Execute ChatView's actual SSH branch and caller toast. Submission-module tests alone cannot prove local-launch bypass, editor edits, capture delivery or route behavior. Use Deferred promises for launch/readiness/navigation transitions, real store.addImage/context setters, and real store assertions without sleeps/polling. Keep orchestration in lib/sshWorktreeSubmission.ts, pure content comparison in ChatView.logic.ts, and snapshot/message assembly in ChatView. No submission state module or lock-only test remains. PR2 proves server stages; PR3 proves reachable feedback and conditional content retention.

Integrated UI acceptance belongs to the parent once, after implementation and explicit browser authorization. Capture before/after composer at narrow/wide widths, panel, saved alternate SSH route, disabled host, attachment reason, permission denial, launch error and successful remote route. Do not start servers or use a browser in this delegated task.

## Verifiers — PLAN-VERIFIER-REAL-01

All executed commands ran from `/Users/jun/.goat/worktrees/goat/t3-8cf0da21` with:

```sh
export PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
```

The commands below are prior coordinator baseline evidence against the **current tree**, before any implementation; this docs-only amendment did not rerun them. All named current test files exist. No repo-wide checks or servers were run.

| Verifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exit | Result                                                                                                         | Reads change target?                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `vp test run apps/web/src/composerDraftStore.test.ts apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/BranchToolbar.panel.test.tsx apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/components/ChatView.logic.test.ts`                                                                                                                                                                                                                                                                                                                    | 0    | 5 files, 369 tests passed; duration 2.19s.                                                                     | Yes: imports current store, new-thread hook, toolbar and ChatView logic. Does not execute future SSH branch/modules. |
| `vp run --filter @t3tools/web typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0    | `~/apps/web$ tsc --noEmit`, cache disabled.                                                                    | Yes: apps/web/tsconfig.json includes src. Does not prove absent PR2 types/new SSH code.                              |
| `vp lint apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.ts apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/components/BranchToolbar.logic.ts apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/BranchToolbar.tsx apps/web/src/components/BranchToolbarEnvModeSelector.tsx apps/web/src/components/BranchToolbar.panel.test.tsx apps/web/src/components/chat/ThreadDetailsPanel.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.logic.test.ts` | 0    | Existing warnings (unused imports, inline schema compilation, React refs/dependencies/memoization); no errors. | Yes: explicitly targets existing proposed changed files. Does not lint Markdown or nonexistent modules.              |
| `vp lint apps/web/src/components/BranchToolbarBranchSelector.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/ChatView.logic.ts apps/web/src/components/ThreadRouteView.tsx`                                                                                                                                                                                                                                                                                                                                                                          | 0    | Existing ChatComposer React warnings; no errors.                                                               | Yes: all four concrete additional source targets were read by lint.                                                  |

Historical docs-only amendment checks (2026-10-12) reported exit 0 for earlier flow/anchor assertions, including the round-2 external-lock design. Those design assertions are superseded by this changed plan and are not evidence for content-snapshot consumption. Earlier baseline command rows remain coordinator evidence only. The current amendment uses a read-only inline python3 check (`expectedWrites: []`) for balanced fences, launch → bounded wait → navigate → fresh comparison → conditional deletion; started-not-opened conditional clear and caller toast; pure comparator coverage of every current content field; captured-ID reads; connect-only Open ports; no proposed state lock module, lock API/read-only mutation path or future lock verifier; and source anchors for store content/clear/deletion, editor/send busy state, route lifecycle and desktop capture. Executed result for this changed-plan amendment: **exit 0**; **9 current content fields, 25 error-code copy rows and 40 source/document anchors verified**. The check also confirmed the editable/capture test activations, existing busy/control distinction, conditional consumption, removed lock APIs/future state-module verifier and the remaining 020:1233–1234 contradiction. This is read-only document/source consistency evidence, not implementation or audit PASS evidence. No implementation tests, typecheck, lint, server or browser were run for this docs-only task.

After implementation, run the existing command again plus all added tests and newly covered source targets:

```sh
vp test run apps/web/src/components/ChatView.logic.test.ts apps/web/src/components/ChatView.ssh.test.tsx apps/web/src/components/chat/ChatComposer.ssh.test.tsx apps/web/src/lib/sshWorktree.test.ts apps/web/src/lib/sshWorktreeSubmission.test.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/BranchToolbar.panel.test.tsx
vp run --filter @t3tools/web typecheck
vp lint apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.ts apps/web/src/hooks/useHandleNewThread.test.ts apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts apps/web/src/lib/sshWorktree.ts apps/web/src/lib/sshWorktree.test.ts apps/web/src/lib/sshWorktreeSubmission.ts apps/web/src/lib/sshWorktreeSubmission.test.ts apps/web/src/components/WorkspaceMenuItems.tsx apps/web/src/components/BranchToolbarBranchSelector.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.ssh.test.tsx apps/web/src/components/BranchToolbar.logic.ts apps/web/src/components/BranchToolbar.logic.test.ts apps/web/src/components/BranchToolbar.tsx apps/web/src/components/BranchToolbarEnvModeSelector.tsx apps/web/src/components/BranchToolbar.panel.test.tsx apps/web/src/components/chat/ThreadDetailsPanel.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.ssh.test.tsx
```

The first and last future commands were not run because several named modules/tests do not exist yet. The pure comparator logic/tests, concrete ChatComposer, ChatView integration tests and branch targets are in the future commands; no new web command bridge is required. Do not use passWithNoTests to disguise an absent new test. Hosted goat-ci on PR3's exact head is later parent-owned proof, not implied by these baseline exits. Targeted lint does not lint this design Markdown; textual consistency is verified separately.

## Commit plan and PR draft

Implementation commits, performed only by the parent/authorized executor:

1. `feat(web): persist saved SSH worktree destinations in drafts`
2. `feat(web): choose saved SSH worktrees in every workspace menu`
3. `feat(web): launch SSH worktrees and open remote threads`

Keep tests with the behavior they prove. Do not make plan-only commits or commit screenshots; existing unit documentation convention/000's explicit override owns any doc inclusion in PR1.

PR title: `feat(web): start worktrees on saved SSH connections`

PR body draft:

> A draft can choose a local worktree, but cannot copy its current code to a saved SSH host and start a remotely owned thread. The wide workspace selector also cannot show a host submenu.
>
> Add Worktree on SSH to the shared workspace menu and persist the saved destination while retaining the local snapshot source. Send through the guarded SSH workspace service while keeping the composer editable. Capture submitted content, wait for the remote shell and open the saved connection's thread before deleting an unchanged draft; preserve any draft edited during launch. If opening fails after launch, clear unchanged content only, keep the session and show an Open thread toast either way that reconnects and opens without sending again. Launch failures keep all current content with code-specific errors; uncertain launch keeps it with a warning. Attachments and multiple models are disabled with explicit reasons.
>
> Validation: [replace with final focused test/typecheck/lint results and uploaded before/after images]. Current-tree baseline: 369 tests passed; targeted web typecheck and lint exited 0, with existing lint warnings.
>
> Stack: PR1 [link] → PR2 [link] → **this PR3** → PR4 [link]. Base: goat/ws-picker-2-ssh-service. Landing follows M6's child-first merge order.
>
> Model: GPT-6. Harness: Codex. [Replace with actual implementation model/harness if different.]

This draft creates no PR and grants no branch operations to this worker.

## Risks and limits

- Saved environment identity may differ from what a host returns. Keep the successful result ref only in the toast closure, show host/thread identifiers and refuse navigation through a mismatched saved route. Reconnecting/Open is not launch retry.
- No persisted operation receipts (A11). A lost launch response after remote creation remains uncertain across reload; warn and keep draft. Do not claim exactly-once execution. Opened deletes an unchanged draft after navigation; started-not-opened clears unchanged content but retains an ordinary session/mapping. Both leave changed content untouched. That session can persist normally, but no remote ref/outcome/Open action is persisted; the toast action has no launch or draft mutation capability.
- Profiles can be removed, disabled or edited after selection; resolve current identities/targets at execution and expose unavailable selections. Full-target dedup can replace a selected duplicate's representative; the old identity then visibly requires reselection rather than quietly launching on a different environment.
- Draft normalization must not erase non-null SSH intent and then submit locally. The unavailable sentinel is only a blocked client value; it cannot create a target.
- A source-only provider availability check can block remote-valid models. The SSH branch and composer enablement must agree; PR2's remote launch remains authoritative about provider availability and runtime ceiling.
- Attachments, multiple models and environment-bound context chips are deliberately unsupported here. Their visible disable reasons must be reached from button, keyboard and direct annotation activation.
- Content comparison covers every composer content field and reads the captured ID only after navigation/open failure; no await may separate equality check from mutation. Added content preserves the entire draft, including submitted text, so an explicit later send can include that text again. Existing busy/ref behavior is per mounted instance, with no remount-wide duplicate-send guarantee or receipt/exactly-once claim. Test typing/paste, direct desktop capture/addImage and context insertion during launch, A→B→A additions, B preservation and both unchanged consumption paths; Sidebar and ordinary promotion routing need no edits.
- Snapshot history can contain committed secrets. M4's candidate warning is early warning only; PR3 adds no enforcement/bypass policy.
- Baseline checks prove current code and command targeting only. New PR2 wire types, new modules, real SSH dispatch and live client rendering are unverified in this docs-only task.

## Cross-doc reconciliation

020 was read at the final availability check (2026-10-12, current coordinator tree). Its actual commands are `vcsEnvironment.sshWorkspaceLaunch` / `vcsEnvironment.sshWorkspaceFetchBack`, provided by createVcsEnvironmentAtoms; the fallback packet names are local aliases only. No bridge/factory addition is needed. The full launch input/result properties and text-only initialMessage match sections 3/5/6 above. Error stages are validate, preflight, snapshot, remote_init, push, launch and fetch; launch_uncertain is the only explicit uncertain service code. No operationId is accepted from the client. PR3 does not consume fetchBack. Every error code is mapped above. PR2 must continue mapping dispatch launchMayHaveStarted to launch_uncertain; PR3 also warns on untyped transport loss after dispatch begins. The stale client-runtime anchor now links to 020's Layer/handler/client integration section instead of shifting line numbers. The coordinator's current 020 includes project_not_repo_root; its copy and the exhaustive 25-code cases are included. No cross-doc API conflict was found in the prior reconciliation. This amendment edits only 030. 020's field-chain text (ledger after the PR3 row) now matches this conditional consumption (reconciled by the coordinator).

## Plan conflicts

No conflict with 000's resolved decisions was found in the prior reconciliation. This changed-plan amendment replaces the prior locking design within 030 only; source controls currently use envLocked rather than busy, as cited above. The parent owns any stale 020/other-document completion references, fresh audit and implementation; no Decade-doc conflict disposition row was edited. Existing absent SSH fields/menus and the normal branch validation are the intended PR3 changes; PR1's still-present Previous worktree/current-checkout labels are baseline, not a request to reopen D-u1–D-u3. The missing server explorer is an input-evidence gap, recorded above; it is not a change to the accepted server design.
