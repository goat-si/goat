# 040 wp4 / PR4: Fetch branch to this device

## Stale check at wp4 P (branch goat/ws-picker-3-ssh-ui 4454bbe95 = PR1 + PR2 + PR3)

These amendments override older excerpts; line anchors below are historical (ba65eae6b).

1. PR2 is implemented: `createVcsEnvironmentAtoms(...).sshWorkspaceFetchBack` (packages/client-runtime/src/state/vcs.ts),
   input `{ target, remoteWorkspaceRoot, branch }`, result `{ sourceProjectId, localWorkspaceRoot, localRef, commitOid, remoteBranch }`.
   No extra state/sshWorkspace.ts bridge exists or is needed.
2. Fetch failure coverage includes `project_read_failed` (SshWorkspaceSync fetchBack) next to the listed codes.
3. PR3 is implemented: reuse its saved SSH profile helpers in apps/web/src/lib/sshWorktree.ts for host lookup and its
   error copy helper for fetch errors instead of adding parallel ones.
4. Moved anchors: saved SSH profile in packages/client-runtime/src/connection/catalog.ts, desktop guards in
   apps/web/src/connection/platform.ts, `requestGuarded` in rpc/client.ts; re-locate by content.
5. User docs use the GOAT brand.

Depends on [030_phase3_ssh_picker_ui.md](./030_phase3_ssh_picker_ui.md), which depends on
[020_phase2_ssh_workspace_service.md](./020_phase2_ssh_workspace_service.md).
Implementation branch: `goat/ws-picker-4-fetch-back`; PR base: `goat/ws-picker-3-ssh-ui`.
Authority: [000_plan.md](./000_plan.md), including D-u1–D-u7, A1–A14 dispositions and M1–M6.
The parent owns phase transitions, the goal, integration, commits, PRs and landing.

The desktop user can open a managed SSH thread and fetch its committed branch into the
original repository on this device. The action runs on the primary local environment;
its success toast shows the returned local ref. The remote thread continues to belong
to its remote environment.

## Execution contract

This is the wp4 slice of the parent's satisfy-spec stack, triggered by the 2026-10-12
SSH-worktree request. Its goal is the reverse action plus user guidance. Stop when the
scoped implementation/tests pass and its PR is reviewable; this delegated docs task
stops after writing this document and reporting current-tree verifiers. The artifact is
this file; successful design delivery is not feature completion. Missing prerequisite
contracts or an actual contradiction goes to the parent. No child dispatch, FSM/goal
operation, server, browser, branch operation or write outside this file is authorized
for this worker. The unit's landing authority and resource bounds remain in 000.

Inputs read: AGENTS.md, 000, `/tmp/ssh-wt/E1-web.md`, and architect proposal
`/tmp/ssh-wt/01a12bef-12af-7953-b80e-586c1e221b17.md`. The supplied server explorer path
`/tmp/ssh-wt/01a12bef-11a5-7f71-8bb1-debbb865eb09.md` does not exist. Relevant dispatch,
thread metadata, contract and RPC source was read directly instead. At initial drafting,
020 and 030 were being written by sibling workers and were not present. 030 became
available during the final check. 020 also became available before completion; its
fetch schemas, service and command sections were read. This document now uses its
exact command member and payload/result fields. Re-anchor both at the next P stale
check; do not reopen any 000 decision.

The client-runtime command name from 020 is `sshWorkspaceFetchBack`, exported from
`createVcsEnvironmentAtoms` (020's client-command block). Use the existing `vcsEnvironment` web binding.
030's extra `state/sshWorkspace.ts` bridge is conditional on needing a factory; 020
uses the existing VCS factory, so PR4 needs no additional bridge. PR2 owns the
contract/RPC/service; PR4 refreshes local refs/status after success using the returned
localWorkspaceRoot. PR4 creates no second fetch RPC command or transport. Current
VCS mutation conventions are in
`packages/client-runtime/src/state/vcs.ts:297`.

## Scope and entry points

IN:

- A **Fetch branch to this device** menu action for an existing server thread whose
  environment has a saved SSH route and whose **project** workspaceRoot is under
  `.goat/repos`. Read the project root, not the thread worktree path.
- The same action in the command palette, through the same hook and command.
- Selection of the saved SSH profile, including an alternate route, in route preference
  order; disabled saved environments remain visible with a reason. No SSH discovery.
- Primary/local command permission, a shared transient in-flight guard, a local-ref
  success toast and sticky error feedback. No automatic retry.
- Focused eligibility and action tests; remote-access and source-control user sections.

OUT:

- Mobile SSH-worktree UI (explicit 000 non-goal); browser-only SSH provisioning/gateway
  (A12 rejected); changing provider adapters or launch/draft behavior owned by PR1–PR3.
- Receipts, persisted source-project/host metadata, readOperation/connect RPCs (A6/A11).
- Checkout, merge, reset, applying remote uncommitted files, auto-commit, deleting refs,
  or a new compare UI. M5 writes only `refs/remotes/goat-ssh/<alias>/<branch>`.
- Dedicated Settings action: Settings saves/enables SSH connections; fetch is contextual
  to a thread. No new keybinding command/default binding: keyboard users invoke the
  existing command-palette shortcut and select this contextual action.

Surface decisions grounded in current source:

| Surface                                            | Decision and source                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar, thread details panel, compact thread menu | Add to shared `gitItems` in `apps/web/src/components/GitActionsControl.tsx:1686`. It feeds compact submenu `:1818` and toolbar/panel popup `:1964`. Do not add a second thread-header button.                       |
| Command palette                                    | Add to `actionItems` adjacent to thread actions at `apps/web/src/components/CommandPalette.tsx:1979`; use the server route ref at `:510`, not a recently remembered thread or draft.                                |
| Desktop                                            | Enabled only with `window.desktopBridge` and an enabled primary/local catalog entry. SSH provision/prepare currently requires that bridge (`apps/web/src/connection/platform.ts:279`, `:290`), consistent with A12. |
| Local/hosted web                                   | No action without the desktop bridge; keep existing direct/relay/tunnel use of threads intact. No localhost URL or new browser SSH transport.                                                                       |
| Mobile                                             | No action, per unit scope. Shared PR2 RPC schemas still decode on all clients.                                                                                                                                      |
| Providers                                          | Codex, Claude, Cursor, Grok, OpenCode, Antigravity: identical eligibility; this fetch reads Git refs, independent of provider.                                                                                      |
| Agents/scheduled tasks                             | PR2 service is the owner; transports call that service. PR4 creates no handler-owned workflow or separate agent protocol.                                                                                           |
| Reverse/result                                     | Fetch is the way home; returned `localRef` is the visible result. Returning does not migrate thread ownership.                                                                                                      |

## File change map

All paths below are relative to `/Users/jun/.goat/worktrees/goat/t3-8cf0da21`.
NEW paths have no current line; their full source is below. DELETE: none.

| Operation | Exact path                                                | Change                                                                                                 |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| MODIFY    | `apps/web/src/components/GitActionsControl.logic.ts`      | Add pure managed-root/saved-route eligibility resolver with a typed request target.                    |
| MODIFY    | `apps/web/src/components/GitActionsControl.logic.test.ts` | Add the complete eligibility matrix, including alternate routes and renamed branches.                  |
| NEW       | `apps/web/src/hooks/useSshWorkspaceFetchBack.ts`          | Share context, command permission, transient pending guard and result/error toast across entry points. |
| NEW       | `apps/web/src/hooks/useSshWorkspaceFetchBack.test.tsx`    | Real hook mount, deferred command outcome, destination/guard/failure/toast behavior.                   |
| MODIFY    | `apps/web/src/components/GitActionsControl.tsx`           | Insert the action in shared gitItems; allow compact eligibility to retain the action surface.          |
| MODIFY    | `apps/web/src/components/GitActionsControl.test.ts`       | Mock the new hook in the existing callback harness to retain its unrelated branch/permission coverage. |
| MODIFY    | `apps/web/src/components/CommandPalette.logic.ts`         | Build the contextual palette item from the shared action presentation.                                 |
| MODIFY    | `apps/web/src/components/CommandPalette.logic.test.ts`    | Prove searchability and disabled rows cannot be keyboard activated.                                    |
| MODIFY    | `apps/web/src/components/CommandPalette.tsx`              | Bind the hook to routeThreadRef and append its contextual item.                                        |
| MODIFY    | `docs/user/remote-access.md`                              | Document saved-host worktree dispatch, ownership and the reverse action.                               |
| MODIFY    | `docs/user/source-control.md`                             | Explain fetch-only result, ref inspection and committed-content limit.                                 |

`packages/contracts/src/sshWorkspace.ts`, guarded RPC scope entries, server fetch implementation
and client-runtime command tests are PR2 changes, not PR4 files. The explorer's suggested
SSH-origin metadata is superseded by amended A13: no receipt/provenance field is added.

## Per-file implementation

### 1. Dependency binding: `apps/web/src/state/vcs.ts` (existing)

Current `apps/web/src/state/vcs.ts:8` binds `createVcsEnvironmentAtoms` to
`connectionAtomRuntime`; 020 adds the `sshWorkspaceFetchBack` member to that factory.
PR4 makes no edit to this binding. Both UI entry points use the same bound command
through the hook. The command remains `createEnvironmentRpcCommand` based and exposes
`permissionAtom`, as in `packages/client-runtime/src/state/runtime.ts:744`, `:808`.

### 2. `apps/web/src/components/GitActionsControl.logic.ts`

Current imports at `:1` cover Git/VCS types; add `EnvironmentId`, `ScopedThreadRef`,
`OrchestrationV2ThreadShell` and PR2's `SshWorkspaceFetchBackInput` to that type import.
Add the following imports and append the following full logic after the existing helpers
(`:492` currently starts the final re-export). This does not change `buildMenuItems`
or the `GitActionMenuItem` union (`:17`): fetch has a different destination permission.

```ts
import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

export function isManagedSshProjectRoot(workspaceRoot: string): boolean {
  const segments = workspaceRoot.split("/").filter(Boolean);
  if (!workspaceRoot.startsWith("/") || segments.some((part) => part === "." || part === "..")) {
    return false;
  }
  return /^\/(?:[^/]+\/)*\.goat\/repos\/[^/]+(?:\/[^/]+)*\/?$/.test(workspaceRoot);
}

export function resolveSshFetchBackContext(input: {
  readonly isDesktop: boolean;
  readonly threadRef: ScopedThreadRef | null;
  readonly thread: Pick<OrchestrationV2ThreadShell, "branch"> | null;
  readonly workspaceRoot: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly catalog: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
}) {
  const hidden = { visible: false, target: null, disabledReason: null } as const;
  const { threadRef, thread, workspaceRoot, primaryEnvironmentId, catalog } = input;
  if (!input.isDesktop || threadRef === null || thread === null || workspaceRoot === null) {
    return hidden;
  }
  if (threadRef.environmentId === primaryEnvironmentId || !isManagedSshProjectRoot(workspaceRoot)) {
    return hidden;
  }
  const entry = catalog.get(threadRef.environmentId);
  if (entry === undefined) return hidden;
  const route = connectionRoutes(entry).find((candidate) => {
    const profile = Option.getOrNull(candidate.profile);
    return (
      candidate.target._tag === "SshConnectionTarget" &&
      profile?._tag === "SshConnectionProfile" &&
      candidate.target.environmentId === threadRef.environmentId &&
      profile.environmentId === threadRef.environmentId &&
      profile.connectionId === candidate.target.connectionId
    );
  });
  const profile = route ? Option.getOrNull(route.profile) : null;
  if (profile?._tag !== "SshConnectionProfile") return hidden;
  const unavailable = (disabledReason: string) =>
    ({
      visible: true,
      target: null,
      disabledReason,
    }) as const;
  if (!entry.enabled) return unavailable("Enable this SSH environment in Settings → Connections.");
  if (primaryEnvironmentId === null || catalog.get(primaryEnvironmentId)?.enabled !== true) {
    return unavailable("Connect to this device before fetching its branch.");
  }
  if (!thread.branch?.trim()) return unavailable("This thread has no branch to fetch.");
  const rpcInput = {
    target: profile.target,
    remoteWorkspaceRoot: workspaceRoot,
    branch: thread.branch,
  } satisfies SshWorkspaceFetchBackInput;
  return {
    visible: true,
    target: { environmentId: primaryEnvironmentId, input: rpcInput },
    disabledReason: null,
  } as const;
}
```

The resolver accepts any current branch name, including a semantic rename; do not
require `goat/ssh/` and do not substitute `gitCwd` or the launch snapshot ref. The
server validates actual derived managed-root ownership and Git ref syntax in PR2.
The UI path predicate is eligibility, not a security claim or home-directory proof.

### 3. `apps/web/src/hooks/useSshWorkspaceFetchBack.ts` — full new module

Existing hooks supply a shell/project without loading full conversation details
(`apps/web/src/state/entities.ts:110`, `:114`). Live reads use the same atom families
(`apps/web/src/state/threads.ts:28`, `apps/web/src/state/projects.ts:10`). The command
hook returns typed Success/Failure and can suppress generic reporting
(`apps/web/src/state/use-atom-command.ts:10`). Full new source:

```ts
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProject, useThreadShell } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentProjects } from "~/state/projects";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { toastManager } from "~/components/ui/toast";
import {
  resolveGitActionResultToastTiming,
  resolveSshFetchBackContext,
} from "~/components/GitActionsControl.logic";

const pendingByThread = Atom.family((_key: string) => Atom.make(false));
const sshWorkspaceFetchBack = vcsEnvironment.sshWorkspaceFetchBack;

function readContext(threadRef: ScopedThreadRef | null) {
  const thread =
    threadRef === null
      ? null
      : appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef));
  const project =
    threadRef === null || thread === null
      ? null
      : appAtomRegistry.get(
          environmentProjects.projectAtom({
            environmentId: threadRef.environmentId,
            projectId: thread.projectId,
          }),
        );
  return resolveSshFetchBackContext({
    isDesktop: typeof window !== "undefined" && window.desktopBridge !== undefined,
    threadRef,
    thread,
    workspaceRoot: project?.workspaceRoot ?? null,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    catalog: appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
  });
}

export function useSshWorkspaceFetchBack(threadRef: ScopedThreadRef | null) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    threadRef === null || thread === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          projectId: thread.projectId,
        },
  );
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const context = resolveSshFetchBackContext({
    isDesktop: typeof window !== "undefined" && window.desktopBridge !== undefined,
    threadRef,
    thread,
    workspaceRoot: project?.workspaceRoot ?? null,
    primaryEnvironmentId,
    catalog: catalog.entries,
  });
  const pendingAtom = pendingByThread(
    JSON.stringify([threadRef?.environmentId ?? null, threadRef?.threadId ?? null]),
  );
  const isPending = useAtomValue(pendingAtom);
  const permitted = useAtomValue(
    sshWorkspaceFetchBack.permissionAtom(
      context.target?.environmentId ?? null,
      context.target?.input,
    ),
  );
  const disabledReason =
    context.disabledReason ??
    (context.visible && !permitted
      ? "This device's connection cannot change source control."
      : isPending
        ? "Fetching branch to this device..."
        : null);
  const execute = useAtomCommand(sshWorkspaceFetchBack, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
    reportDefect: false,
  });
  const run = useCallback(async (): Promise<void> => {
    if (appAtomRegistry.get(pendingAtom)) return;
    // Read again: a retained palette row can outlive a branch/catalog/grant change.
    const current = readContext(threadRef);
    if (!current.visible) return;
    const target = current.target;
    const canRun =
      target !== null &&
      appAtomRegistry.get(sshWorkspaceFetchBack.permissionAtom(target.environmentId, target.input));
    if (target === null || !canRun) {
      toastManager.add({
        type: "error",
        title: "Cannot fetch branch to this device",
        description:
          current.disabledReason ?? "This device's connection cannot change source control.",
        timeout: 0,
        data: { threadRef },
      });
      return;
    }
    appAtomRegistry.set(pendingAtom, true);
    try {
      const result = await execute(target);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Fetch branch failed",
          description:
            error instanceof Error ? error.message : "Could not fetch the remote branch.",
          timeout: 0,
          data: { threadRef },
        });
        return;
      }
      const timing = resolveGitActionResultToastTiming("success");
      toastManager.add({
        type: "success",
        title: "Branch fetched to this device",
        description: result.value.localRef,
        timeout: timing.timeout,
        data: {
          threadRef,
          ...(timing.dismissAfterVisibleMs === null
            ? {}
            : {
                dismissAfterVisibleMs: timing.dismissAfterVisibleMs,
              }),
        },
      });
      // refreshStatus invalidates live and persisted local refs in onSettled.
      const refreshed = await refreshLocalStatus({
        environmentId: target.environmentId,
        input: { cwd: result.value.localWorkspaceRoot },
      });
      if (refreshed._tag === "Failure" && !isAtomCommandInterrupted(refreshed)) {
        const error = squashAtomCommandFailure(refreshed);
        toastManager.add({
          type: "error",
          title: "Branch fetched; local Git status refresh failed",
          description:
            error instanceof Error ? error.message : "Refresh Git status to see the fetched ref.",
          timeout: 0,
          data: { threadRef },
        });
      }
    } finally {
      appAtomRegistry.set(pendingAtom, false);
    }
  }, [execute, pendingAtom, refreshLocalStatus, threadRef]);
  return {
    visible: context.visible,
    isPending,
    disabled: !context.visible || context.target === null || !permitted || isPending,
    disabledReason,
    label: isPending ? "Fetching branch to this device..." : "Fetch branch to this device",
    run,
  };
}
```

The command wrapper converts defects to Failure (`packages/client-runtime/src/state/runtime.ts:146`);
the hook consumes that result rather than adding retry machinery. Its synchronous atom
lock covers menu/palette simultaneous clicks on the same thread, unlike two independent
`useState` values. It is transient, never persisted, and clears on failure/interruption.
Command authorization also checks the destination at execution (`runtime.ts:792`).
A command already sent remains attached to the captured threadRef; switching threads
while it is pending does not move its result toast to the new thread.

Local refresh uses the existing guarded `vcsEnvironment.refreshStatus` command
(`packages/client-runtime/src/state/vcs.ts:304`), whose `onSettled` invalidates refs
at `:309` using `invalidateCachedVcsRefs`. It clears persisted snapshots before
restarting ref streams (`state/vcsRefInvalidation.ts:59`). Its failure does not undo
or retry the successful fetch; the success toast remains and the refresh error says
the branch was already fetched. No local branch/status refresh is sent on fetch failure.

### 4. `apps/web/src/components/GitActionsControl.tsx`

Add `import { useSshWorkspaceFetchBack } from "~/hooks/useSshWorkspaceFetchBack";` near
existing hook imports (`:108`). Immediately after the function's unconditional hooks
begin at `:1086`, bind:

```ts
const sshFetchBack = useSshWorkspaceFetchBack(draftId === undefined ? activeThreadRef : null);
```

Before at `:1743`, the ordinary menu map is followed directly by publish:

```tsx
      })}
      {canPublishRepository ? (
```

After:

```tsx
      })}
      {sshFetchBack.visible ? (
        <div>
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            disabled={sshFetchBack.disabled}
            onClick={() => { void sshFetchBack.run(); }}
          >
            <CloudDownloadIcon />
            <MenuItemLabel>{sshFetchBack.label}</MenuItemLabel>
          </MenuItem>
          {sshFetchBack.disabledReason ? (
            <p className="max-w-64 px-2 pb-2 text-xs text-muted-foreground">
              {sshFetchBack.disabledReason}
            </p>
          ) : null}
        </div>
      ) : null}
      {canPublishRepository ? (
```

Do **not** combine fetch disabled state with `canWriteSourceControl` (`:1095`) or
`isGitActionRunning`: both concern the **remote** repo, whereas this fetch mutates
the **local** repo. The PR2 command grants are checked on the primary environment.
Remote read-only access to a visible thread is sufficient for deriving its branch.

Two parent menu guards currently stop access before the new item can render:
`MenuSubTrigger disabled={isGitActionRunning}` at `:1814` and
`MenuTrigger disabled={isGitActionRunning}` at `:1957`. Replace both with:

```tsx
disabled={isGitActionRunning && !sshFetchBack.visible}
```

Retain existing per-item remote guards, so other remote Git operations remain disabled
while the remote is busy. At `:1836` replace:

```tsx
compact && !gitActionProgress && !visibleInlineSuccess ? null : (
```

with:

```tsx
compact && !gitActionProgress && !visibleInlineSuccess && !sshFetchBack.visible ? null : (
```

One more conditional at `:1924` replaces the panel menu with an elapsed counter while
a remote Git action runs. Replace `isPanel && gitActionProgress ? (` with:

```tsx
isPanel && gitActionProgress && !sshFetchBack.visible ? (
```

This keeps the menu available for a local fetch while the remote progress remains in
the primary row. This makes the shared action reachable even on compact details layouts. No spinner,
new animation, source-control quick-action replacement or panel-only success shortcut:
the task requires the local-ref toast for every presentation.

### 5. `apps/web/src/components/CommandPalette.logic.ts`

Append after `CommandPaletteActionItem` at `:150` (which already supports `disabled`
via `CommandPaletteItem` at `:140`). The function shares the hook's presentation;
it introduces no shortcutCommand or keybinding contract value.

```ts
export function buildSshFetchBackActionItem(input: {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly disabledReason: string | null;
  readonly run: () => Promise<void>;
  readonly icon: ReactNode;
}): CommandPaletteActionItem | null {
  if (!input.visible) return null;
  return {
    kind: "action",
    value: "action:ssh-workspace-fetch-back",
    title: input.label,
    searchTerms: ["fetch", "branch", "ssh", "this device", "local", "bring back"],
    disabled: input.disabled,
    ...(input.disabledReason === null ? {} : { description: input.disabledReason }),
    icon: input.icon,
    run: input.run,
  };
}
```

### 6. `apps/web/src/components/CommandPalette.tsx`

Add `CloudDownloadIcon` to the lucide import at `:49`; import the hook and add
`buildSshFetchBackActionItem` to the existing logic imports. Bind **unconditionally**
after the server route ref at `:510`:

```ts
const sshFetchBack = useSshWorkspaceFetchBack(routeThreadRef);
```

Before: the `:1979` thread actions start with the pull-request capability check.
Insert immediately before it:

```tsx
const sshFetchBackItem = buildSshFetchBackActionItem({
  ...sshFetchBack,
  icon: <CloudDownloadIcon className={ITEM_ICON_CLASS} />,
});
if (sshFetchBackItem !== null) actionItems.push(sshFetchBackItem);
```

Use the actual route ref rather than the active-thread fallback at `:771`; otherwise
the global palette on another page can act on a remembered thread. Existing disabled
row navigation at `CommandPalette.logic.ts:209` skips this item while pending or denied.
The hook consumes failure/toast feedback so the palette's generic action error path
does not create a second error toast.

### 7. Test file edits and full new hook test

`apps/web/src/components/GitActionsControl.logic.test.ts:1`: expand the contracts import
to include `EnvironmentId`, `ThreadId`; add `SshConnectionTarget`, `SshConnectionProfile`,
`BearerConnectionTarget`, `PrimaryConnectionTarget`, `ConnectionCatalogEntry` from
`@t3tools/client-runtime/connection`, and `Option` from `effect/Option`. Import both new
resolver exports at `:3`. Append these fixtures and tests (existing Git cases remain):

```ts
const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const savedTarget = { alias: "build", hostname: "build.example", username: "dev", port: 2222 };
const savedRoute = {
  target: new SshConnectionTarget({
    environmentId: remoteId,
    connectionId: "saved",
    label: "Build",
  }),
  profile: Option.some(
    new SshConnectionProfile({
      environmentId: remoteId,
      connectionId: "saved",
      label: "Build",
      target: savedTarget,
    }),
  ),
};
const primaryEntry: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: localId,
    label: "This device",
    httpBaseUrl: "http://localhost",
    wsBaseUrl: "ws://localhost",
  }),
  profile: Option.none(),
  enabled: true,
};
function fetchContext(overrides: Partial<Parameters<typeof resolveSshFetchBackContext>[0]> = {}) {
  return resolveSshFetchBackContext({
    isDesktop: true,
    threadRef: { environmentId: remoteId, threadId: ThreadId.make("thread") },
    thread: { branch: "feature/renamed" },
    workspaceRoot: "/home/dev/.goat/repos/app-12345678",
    primaryEnvironmentId: localId,
    catalog: new Map([
      [localId, primaryEntry],
      [remoteId, { ...savedRoute, enabled: true }],
    ]),
    ...overrides,
  });
}
describe("SSH fetch-back eligibility", () => {
  it("routes a renamed branch and the project root to the primary environment", () => {
    assert.deepEqual(fetchContext().target, {
      environmentId: localId,
      input: {
        target: savedTarget,
        remoteWorkspaceRoot: "/home/dev/.goat/repos/app-12345678",
        branch: "feature/renamed",
      },
    });
  });
  it("uses a saved alternate SSH route in preference order", () => {
    const secondRoute = {
      target: new SshConnectionTarget({
        environmentId: remoteId,
        connectionId: "second",
        label: "Other route",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId: remoteId,
          connectionId: "second",
          label: "Other route",
          target: { ...savedTarget, port: 2223 },
        }),
      ),
    };
    const entry: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId: remoteId,
        connectionId: "direct",
        label: "Build",
      }),
      profile: Option.none(),
      alternateRoutes: [savedRoute, secondRoute],
      enabled: true,
    };
    assert.deepEqual(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [remoteId, entry],
        ]),
      }).target?.input.target,
      savedTarget,
    );
  });
  it("hides local, draft, unloaded, browser and unmanaged threads", () => {
    for (const patch of [
      { isDesktop: false },
      { threadRef: null },
      { thread: null },
      { workspaceRoot: null },
      { threadRef: { environmentId: localId, threadId: ThreadId.make("local-thread") } },
      { workspaceRoot: "/home/dev/work/app" },
    ])
      assert.equal(fetchContext(patch).visible, false);
  });
  it("hides unsaved and non-SSH environments", () => {
    assert.equal(fetchContext({ catalog: new Map([[localId, primaryEntry]]) }).visible, false);
    assert.equal(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [
            remoteId,
            {
              ...primaryEntry,
              target: new BearerConnectionTarget({
                environmentId: remoteId,
                connectionId: "direct",
                label: "Build",
              }),
            },
          ],
        ]),
      }).visible,
      false,
    );
  });
  it("refuses route/profile identity mismatch", () => {
    for (const fields of [
      { environmentId: localId, connectionId: "saved" },
      { environmentId: remoteId, connectionId: "other" },
    ]) {
      const profile = new SshConnectionProfile({ ...fields, label: "Other", target: savedTarget });
      assert.equal(
        fetchContext({
          catalog: new Map([
            [localId, primaryEntry],
            [
              remoteId,
              {
                ...savedRoute,
                profile: Option.some(profile),
                enabled: true,
              },
            ],
          ]),
        }).visible,
        false,
      );
    }
    assert.equal(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [
            remoteId,
            {
              ...savedRoute,
              target: new SshConnectionTarget({
                environmentId: localId,
                connectionId: "saved",
                label: "Wrong environment",
              }),
              enabled: true,
            },
          ],
        ]),
      }).visible,
      false,
    );
  });
  it("shows a disabled action for a disabled saved SSH environment", () => {
    const result = fetchContext({
      catalog: new Map([
        [localId, primaryEntry],
        [remoteId, { ...savedRoute, enabled: false }],
      ]),
    });
    assert.equal(result.visible, true);
    assert.equal(result.target, null);
    assert.match(result.disabledReason ?? "", /Enable this SSH environment/);
  });
  it("shows a disabled action when the primary connection is missing or disabled", () => {
    for (const result of [
      fetchContext({ primaryEnvironmentId: null }),
      fetchContext({ catalog: new Map([[remoteId, { ...savedRoute, enabled: true }]]) }),
      fetchContext({
        catalog: new Map([
          [localId, { ...primaryEntry, enabled: false }],
          [remoteId, { ...savedRoute, enabled: true }],
        ]),
      }),
    ]) {
      assert.equal(result.visible, true);
      assert.equal(result.target, null);
      assert.match(result.disabledReason ?? "", /Connect to this device/);
    }
  });
  it("shows a disabled action for a null or whitespace branch", () => {
    for (const branch of [null, "", "   "]) {
      const result = fetchContext({ thread: { branch } });
      assert.equal(result.visible, true);
      assert.equal(result.target, null);
      assert.match(result.disabledReason ?? "", /no branch/);
    }
  });
  it("rejects path traversal and lookalike directories", () => {
    for (const path of [
      "~/.goat/repos/app",
      "/home/dev/.goat/repos",
      "/home/dev/.goat/repos2/app",
      "/home/dev/not.goat/repos/app",
      "/home/dev/.goat/repos/../app",
      "/home/dev/.goat/repos/./app",
    ]) {
      assert.equal(isManagedSshProjectRoot(path), false);
    }
    assert.equal(isManagedSshProjectRoot("/Users/dev/.goat/repos/app-12345678/"), true);
  });
});
```

`apps/web/src/components/GitActionsControl.test.ts:24` mocks React hook behavior;
keep its existing eight branch/permission cases intact by adding this mock before the
component import at `:171`. Fetch outcomes belong to the real new hook tests below.

```ts
vi.mock("~/hooks/useSshWorkspaceFetchBack", () => ({
  useSshWorkspaceFetchBack: () => ({
    visible: false,
    disabled: true,
    isPending: false,
    disabledReason: null,
    label: "Fetch branch to this device",
    run: async () => {},
  }),
}));
```

`apps/web/src/components/CommandPalette.logic.test.ts:5`: add the builder import, then
append the following behavioral tests. They use the real search/navigation functions,
not static render assertions or mere callback wiring:

```ts
describe("SSH fetch-back command palette", () => {
  it("makes the eligible action searchable by fetch and SSH", () => {
    const item = buildSshFetchBackActionItem({
      visible: true,
      disabled: false,
      label: "Fetch branch to this device",
      disabledReason: null,
      icon: null,
      run: async () => {},
    })!;
    for (const query of ["fetch", "ssh", "local"]) {
      const groups = filterCommandPaletteGroups({
        activeGroups: [{ value: "actions", label: "Actions", items: [item] }],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        settingsSearchItems: [],
        threadSearchItems: [],
      });
      expect(groups.flatMap((group) => group.items).map((entry) => entry.value)).toContain(
        item.value,
      );
    }
  });
  it("omits ineligible threads and excludes denied or pending actions from keyboard navigation", () => {
    const action = {
      visible: false,
      disabled: true,
      label: "Fetch branch to this device",
      disabledReason: "This device's connection cannot change source control.",
      icon: null,
      run: async () => {},
    };
    expect(buildSshFetchBackActionItem(action)).toBeNull();
    const item = buildSshFetchBackActionItem({ ...action, visible: true })!;
    const rows = buildCommandPaletteRows([{ value: "actions", label: "Actions", items: [item] }]);
    expect(rows.itemValues).toEqual([]);
    expect(rows.rows.find((row) => row.kind === "item")?.itemIndex).toBeNull();
  });
});
```

Full new `apps/web/src/hooks/useSshWorkspaceFetchBack.test.tsx` follows. It mounts real
React and atom subscriptions as existing `useSettings.sync.test.tsx:80` does, with an
isolated atom registry and typed transport outcomes. No SSH process, live app state,
server, sleep or browser is needed.

```tsx
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  SshWorkspaceError,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  primary: null as Atom.Writable<EnvironmentId | null> | null,
  catalog: null as Atom.Writable<{
    entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  }> | null,
  thread: null as Atom.Writable<{ projectId: ProjectId; branch: string | null } | null> | null,
  project: null as Atom.Writable<{ workspaceRoot: string } | null> | null,
  permitted: null as Atom.Writable<boolean> | null,
  execute: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/primaryEnvironment", () => ({
  get primaryEnvironmentIdAtom() {
    return state.primary;
  },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    get catalogValueAtom() {
      return state.catalog;
    },
  },
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => state.thread },
}));
vi.mock("~/state/projects", () => ({ environmentProjects: { projectAtom: () => state.project } }));
vi.mock("~/state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useThreadShell: () => useAtomValue(state.thread!),
    useProject: () => useAtomValue(state.project!),
  };
});
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    sshWorkspaceFetchBack: {
      permissionAtom: (environmentId: EnvironmentId | null) => {
        if (environmentId !== null && environmentId !== "local")
          throw new Error("Permission read on the remote environment");
        return state.permitted;
      },
    },
    refreshStatus: "refresh-status",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refresh-status" ? state.refresh : state.execute,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => state.toast(...args) },
}));

import { useSshWorkspaceFetchBack } from "./useSshWorkspaceFetchBack";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = { environmentId: remote, threadId: ThreadId.make("thread") };
const target = { alias: "build", hostname: "build.example", username: "dev", port: 2222 };
const localRef = "refs/remotes/goat-ssh/build/feature/result";
const fetched = {
  localRef,
  localWorkspaceRoot: "/local/app",
  sourceProjectId: ProjectId.make("local-project"),
  commitOid: "1234567890123456789012345678901234567890",
  remoteBranch: "feature/result",
};
const entries = (): ReadonlyMap<EnvironmentId, ConnectionCatalogEntry> =>
  new Map([
    [
      local,
      {
        enabled: true,
        profile: Option.none(),
        target: new PrimaryConnectionTarget({
          environmentId: local,
          label: "This device",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
      },
    ],
    [
      remote,
      {
        enabled: true,
        target: new SshConnectionTarget({
          environmentId: remote,
          connectionId: "saved",
          label: "Build",
        }),
        profile: Option.some(
          new SshConnectionProfile({
            environmentId: remote,
            connectionId: "saved",
            label: "Build",
            target,
          }),
        ),
      },
    ],
  ]);
let renderer: ReactTestRenderer | undefined;
let actions: Array<ReturnType<typeof useSshWorkspaceFetchBack>> = [];
function Probe({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  actions.push(useSshWorkspaceFetchBack(threadRef));
  return null;
}
async function mount(threadRef: ScopedThreadRef | null = ref, count = 1) {
  await act(() => {
    const content = (
      <RegistryContext.Provider value={state.registry!}>
        {Array.from({ length: count }, (_, index) => (
          <Probe key={index} threadRef={threadRef} />
        ))}
      </RegistryContext.Provider>
    );
    if (renderer) renderer.update(content);
    else renderer = create(content);
  });
  return actions.at(-1)!;
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: {} });
  state.registry = AtomRegistry.make();
  state.primary = Atom.make<EnvironmentId | null>(local);
  state.catalog = Atom.make({ entries: entries() });
  state.thread = Atom.make<{ projectId: ProjectId; branch: string | null } | null>({
    projectId: ProjectId.make("remote-project"),
    branch: "feature/result",
  });
  state.project = Atom.make<{ workspaceRoot: string } | null>({
    workspaceRoot: "/home/dev/.goat/repos/app-12345678",
  });
  state.permitted = Atom.make(true);
  state.execute.mockReset().mockResolvedValue(AsyncResult.success(fetched));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
  actions = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});
describe("useSshWorkspaceFetchBack", () => {
  it("fetches on this device and shows the exact returned ref without changing the remote thread", async () => {
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledWith({
      environmentId: local,
      input: {
        target,
        remoteWorkspaceRoot: "/home/dev/.goat/repos/app-12345678",
        branch: "feature/result",
      },
    });
    expect(state.registry!.get(state.thread!)).toEqual({
      projectId: "remote-project",
      branch: "feature/result",
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: localRef,
        data: expect.objectContaining({ threadRef: ref }),
      }),
    );
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: local,
      input: { cwd: "/local/app" },
    });
  });
  it("prevents simultaneous menu and palette requests until the first finishes", async () => {
    const result = deferred<ReturnType<typeof AsyncResult.success<typeof fetched>>>();
    state.execute.mockReturnValue(result.promise);
    await mount(ref, 2);
    const first = actions.at(-2)!;
    const second = actions.at(-1)!;
    let running!: Promise<void>;
    await act(async () => {
      running = first.run();
      await second.run();
    });
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(actions.at(-1)?.isPending).toBe(true);
    await act(async () => {
      result.resolve(AsyncResult.success(fetched));
      await running;
    });
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("rechecks a revoked local grant and never dispatches from a retained callback", async () => {
    const action = await mount();
    await act(() => state.registry!.set(state.permitted!, false));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", timeout: 0 }),
    );
  });
  it("rechecks a removed saved connection and never fetches from a retained callback", async () => {
    const action = await mount();
    await act(() => state.registry!.set(state.catalog!, { entries: new Map() }));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("blocks a disabled host or a missing branch or project after the menu opened", async () => {
    const action = await mount();
    const disabled = new Map(entries());
    disabled.set(remote, { ...disabled.get(remote)!, enabled: false });
    await act(() => state.registry!.set(state.catalog!, { entries: disabled }));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Enable this SSH environment"),
      }),
    );
    await act(() => {
      state.registry!.set(state.catalog!, { entries: entries() });
      state.registry!.set(state.thread!, {
        projectId: ProjectId.make("remote-project"),
        branch: null,
      });
    });
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringContaining("no branch") }),
    );
    await act(() => state.registry!.set(state.project!, null));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("uses a renamed current branch when the old palette callback runs", async () => {
    const action = await mount();
    await act(() =>
      state.registry!.set(state.thread!, {
        projectId: ProjectId.make("remote-project"),
        branch: "feature/renamed",
      }),
    );
    await act(() => action.run());
    expect(state.execute.mock.calls[0]?.[0].input.branch).toBe("feature/renamed");
  });
  it("shows server refusal or transport failure once and allows only an explicit retry", async () => {
    const failures = [
      new SshWorkspaceError({ stage: "validate", code: "source_not_found", host: "build" }),
      new SshWorkspaceError({ stage: "validate", code: "source_ambiguous", host: "build" }),
      new SshWorkspaceError({ stage: "validate", code: "invalid_branch", host: "build" }),
      new SshWorkspaceError({ stage: "validate", code: "invalid_target", host: "build" }),
      new SshWorkspaceError({ stage: "fetch", code: "host_unavailable", host: "build" }),
      new SshWorkspaceError({ stage: "fetch", code: "invalid_remote_response", host: "build" }),
      new SshWorkspaceError({ stage: "fetch", code: "foreign_path", host: "build" }),
      new SshWorkspaceError({ stage: "fetch", code: "fetch_failed", host: "build" }),
      new Error("This connection requires source-control:write"),
      new Error("WebSocket disconnected"),
    ];
    for (const error of failures) {
      state.execute.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(error)));
      const action = await mount();
      const before = state.execute.mock.calls.length;
      await act(() => action.run());
      expect(state.execute).toHaveBeenCalledTimes(before + 1);
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "error", description: error.message, timeout: 0 }),
      );
      expect(actions.at(-1)?.isPending).toBe(false);
      expect(state.refresh).not.toHaveBeenCalled();
    }
    await act(() => actions.at(-1)!.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
  });
  it("clears pending after interruption without reporting success or retrying", async () => {
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.interrupt(0)));
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).not.toHaveBeenCalled();
    expect(actions.at(-1)?.isPending).toBe(false);
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it("keeps fetch success when local status refresh fails without fetching again", async () => {
    state.refresh.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Local refresh unavailable"))),
    );
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Branch fetched; local Git status refresh failed",
        description: "Local refresh unavailable",
      }),
    );
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("retains fetch success and suppresses an interrupted local refresh error", async () => {
    state.refresh.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("uses bounded fallback copy for unstructured fetch or refresh failures", async () => {
    state.execute.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail("unstructured fetch error")),
    );
    const action = await mount();
    await act(() => action.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Could not fetch the remote branch." }),
    );
    state.refresh.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail("unstructured refresh error")),
    );
    await act(() => action.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Refresh Git status to see the fetched ref." }),
    );
  });
  it("keeps an in-flight result attributed to the original thread after navigation", async () => {
    const result = deferred<ReturnType<typeof AsyncResult.success<typeof fetched>>>();
    state.execute.mockReturnValue(result.promise);
    const action = await mount();
    let running!: Promise<void>;
    await act(() => {
      running = action.run();
    });
    await mount({ ...ref, threadId: ThreadId.make("other-thread") });
    await act(async () => {
      result.resolve(AsyncResult.success(fetched));
      await running;
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadRef: ref }) }),
    );
  });
});
```

### 8. `docs/user/remote-access.md`

Before at `docs/user/remote-access.md:191`: `### Let an agent start work on another machine`.
Insert the following complete section immediately before it, inside Desktop-managed SSH:

```md
### Start a worktree on a saved SSH host

In the desktop app, save the host in **Settings → Connections**, then open a new
thread in a project on this device. In the workspace menu, choose **Worktree on SSH**
and the saved host. Send your message to start the thread there.

GOAT copies the project's commits and current tracked and untracked changes into
`~/.goat/repos` on that host, then creates a new worktree. Untracked files that Git
ignores (such as `.env`) stay behind; files already committed travel with the history.
Provider credentials stay on their machines, and the thread belongs to the
remote environment. Use SSH keys or an ssh-agent; password prompts are unsupported.
The new worktree's setup script follows that host's own project script settings; if the
host has no setup script configured, install dependencies there yourself.

The secret-file check is an early warning for common newly added credential filenames.
It does not scan tracked files or commit history. Keep secrets out of the project
before copying it. If a launch response is lost, the thread may already have started;
check that host's threads before sending again.

To bring committed work home, open the remote thread and choose **Fetch branch to
this device** in **Git actions**, or search for it in the command palette. The result
shows a local ref you can inspect in the original repository. See
[Fetch a branch from an SSH worktree](./source-control.md#fetch-a-branch-from-an-ssh-worktree).

SSH worktree creation and fetch-back are available in the desktop app. The remote
thread can also be followed through an existing web or mobile connection.
```

If PR3 already inserted this same SSH-worktree section, replace it with this final text;
do not append a duplicate account. Preserve the separate agent-dispatch section,
which uses discovered hosts and deliberately has a different host-selection model.

### 9. `docs/user/source-control.md`

Before at `docs/user/source-control.md:13`: `## Connect an account`.
Insert the following section after Review turn changes, before Connect an account:

```md
## Fetch a branch from an SSH worktree

For a thread started with **Worktree on SSH**, open it in the desktop app and choose
**Git actions → Fetch branch to this device**, or find the action in the command
palette. Keep the host saved and enabled in **Settings → Connections**.

The branch is fetched into the original repository on this device. The result shows
`refs/remotes/goat-ssh/<alias>/<branch>`. Fetching leaves your current branch, staged
changes and working files in place. It brings back committed work; commit changes
on the remote thread before fetching if you need them locally.

In a terminal in the original repository, inspect the exact ref shown in the result:

    git log --oneline "HEAD..refs/remotes/goat-ssh/<alias>/<branch>"
    git diff "HEAD...refs/remotes/goat-ssh/<alias>/<branch>"

Replace `<alias>` and `<branch>` with the values from your result. You can then choose
how to merge or cherry-pick the commits. Fetching itself does not merge them.

If this device no longer has the original project at its original location, fetching
is refused. Reconnect this device or enable the saved SSH environment when the action
is disabled. The thread stays on its remote host after fetching.
```

## PLAN-FIELD-CHAIN-01

PR4 introduces no persisted thread/draft fields and no new wire schema. It consumes
PR2's typed input/result. The exact 020 schema spellings are
`{ target, remoteWorkspaceRoot, branch }` (020's `SshWorkspaceFetchBackInput`) and
`{ sourceProjectId, localWorkspaceRoot, localRef, commitOid, remoteBranch }`
(020's `SshWorkspaceFetchBackResult`).

| Field/value                                           | Creation → serialization → deserialization → consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`                                              | Settings' saved `SshConnectionProfile.target` (`packages/client-runtime/src/connection/catalog.ts:44`, target schema `packages/contracts/src/ipc.ts:388`) → profileStore.put/get (`apps/web/src/connection/storage.ts:649`, `:641`), catalog schema encode/decode (`:68`, `:67`) → resolver reads `connectionRoutes` (`routes.ts:49`), preserving alias/hostname/username/port → PR2 fetch input encoded by the typed RPC client → PR2 schema/server service → SSH fetch. No `discoverSshHosts`, bare alias reconstruction or UI credential storage. |
| `remoteWorkspaceRoot`                                 | PR2 registers remote project with managed repo root; existing project shell exposes `workspaceRoot` (`packages/contracts/src/orchestrationProject.ts:9`, `:12`) → existing shell stream/cache → `useProject` (`apps/web/src/state/entities.ts:110`) and click-time project atom → copy into fetch input.remoteWorkspaceRoot → PR2 deserializer → derive matching local source project from remote-root equality per amended A13. Not thread.worktreePath, not a persisted sourceProjectId receipt.                                                   |
| `branch`                                              | Remote workspace metadata update (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:477`) and later rename updates → existing thread shell `packages/contracts/src/orchestrationV2.ts:1851` → shell stream/cache → `useThreadShell` (`entities.ts:114`) and click-time atom → PR2 schema/server Git branch validation → fetch. Do not restrict it to the launch-time `goat/ssh/<opId>` string.                                                                                                                                                |
| `environmentId` command envelope                      | Derived only from primary catalog target by `apps/web/src/state/primaryEnvironment.ts:5` → passed as environment command target, not duplicated in RPC payload → command executes with local supervisor and destination authorization (`packages/client-runtime/src/state/runtime.ts:788`) → local service. Remote threadRef is only context/result attribution.                                                                                                                                                                                     |
| `localRef`                                            | PR2 service creates/fetches `refs/remotes/goat-ssh/<alias>/<branch>` under M5 → PR2 result schema → JSON RPC response → typed Success value → toast.description exactly equals server localRef. UI never fabricates a success ref from a launch alias/branch or parses Git stdout.                                                                                                                                                                                                                                                                   |
| `localWorkspaceRoot`                                  | PR2 source-project match determines actual local root → result schema → typed Success → existing local refreshStatus command input.cwd → onSettled clears persisted local refs and restarts live refs. No UI basename guessing or remote gitCwd refresh.                                                                                                                                                                                                                                                                                             |
| `sourceProjectId`, `commitOid`, `remoteBranch`        | PR2 matched project/ref resolution → existing PR2 result codec → decoded Success; **N/A new PR4 consumers:** not needed for the local-ref toast/refresh and not persisted here. No new compare/checkout behavior.                                                                                                                                                                                                                                                                                                                                    |
| Error stage/code/message                              | PR2 service creates typed failure → PR2 RPC error schema → typed command Failure → `squashAtomCommandFailure` → one sticky error toast. No new error taxonomy in PR4. PR2 owns actual stage/code values and service activation tests.                                                                                                                                                                                                                                                                                                                |
| `visible`, `disabledReason`, `target` resolver result | Derived from live catalog/shell/project → **N/A serialization/deserialization:** ephemeral pure UI projection → hook → shared menu and palette. Hidden vs disabled states are tested below.                                                                                                                                                                                                                                                                                                                                                          |
| `pendingByThread` boolean/key                         | Synchronous set before command dispatch → **N/A persistence/wire:** transient atom family key `[environmentId,threadId]` → both mounted hook instances subscribe → disabled label/duplicate guard → finally clears. No operation receipt, filesystem write or retained retry state.                                                                                                                                                                                                                                                                  |
| `action:ssh-workspace-fetch-back`                     | Palette builder creates contextual item → **N/A wire/persistence:** client-only search/keyboard row value → existing search and enabled-row navigation; no KeybindingCommand/schema/default binding.                                                                                                                                                                                                                                                                                                                                                 |
| Toast `threadRef` / timing                            | Capture invoking scoped threadRef before await + existing success timing resolver `GitActionsControl.logic.ts:59` → **N/A persistence:** toast manager data → existing thread-scoped toast rendering. This does not add any event-sourced thread metadata.                                                                                                                                                                                                                                                                                           |

Actual transport: `packages/client-runtime/src/rpc/client.ts:189` invokes the typed
method after authorization; `rpc/session.ts:202` uses `RpcSerialization.layerJson`
at `:212` with transport retries disabled. PR2 must include input/success/failure
schemas in WsRpcGroup and its guarded scope map. PR4 uses `permissionAtom` both in
render and immediately before dispatch (`state/commandPermissions.ts:39`).

## Test plan and activation grounding

Tests proposed above are **not executed on this design-only tree**. Current-tree
baseline proof is separate below. Before calling PR4 done, run the new tests with PR2
and PR3 integrated, and record assertion output for each guard. No sleeps or polling.

| Exact test file / named case                                                                                                       | Activation → observation                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitActionsControl.logic.test.ts` / `routes a renamed branch and the project root to the primary environment`                      | Saved SSH managed project, semantic branch → request envelope is primaryId, full saved target/root/current branch.                                                                                                                                                                                                                                                                                                   |
| Same / `uses a saved alternate SSH route in preference order`                                                                      | Preferred direct route + two alternate saved SSH profiles → first SSH target is selected with its full user/port.                                                                                                                                                                                                                                                                                                    |
| Same / `hides local, draft, unloaded, browser and unmanaged threads`                                                               | Each absent/unsupported context independently → visible false, no request target.                                                                                                                                                                                                                                                                                                                                    |
| Same / `hides unsaved and non-SSH environments`                                                                                    | Missing catalog entry or direct/relay-only route → hidden.                                                                                                                                                                                                                                                                                                                                                           |
| Same / `refuses route/profile identity mismatch`                                                                                   | Profile environmentId, profile connectionId, or route environmentId differs → each separately hidden.                                                                                                                                                                                                                                                                                                                |
| Same / `shows a disabled action for a disabled saved SSH environment`                                                              | enabled false with retained catalog metadata → visible disabled reason names Connections.                                                                                                                                                                                                                                                                                                                            |
| Same / `shows a disabled action when the primary connection is missing or disabled`                                                | null primaryId, missing primary entry, disabled primary entry → no request and local-connection reason.                                                                                                                                                                                                                                                                                                              |
| Same / `shows a disabled action for a null or whitespace branch`                                                                   | null/empty/space branch → no request and branch reason; no launch-ref fallback.                                                                                                                                                                                                                                                                                                                                      |
| Same / `rejects path traversal and lookalike directories`                                                                          | `.goat/repos2`, similarly named segment, no child, dot/dotdot, relative root → false; real absolute Mac/Linux root → true.                                                                                                                                                                                                                                                                                           |
| `useSshWorkspaceFetchBack.test.tsx` / `fetches on this device and shows the exact returned ref without changing the remote thread` | Success outcome → local destination, root and branch exact; ref toast and unchanged remote metadata.                                                                                                                                                                                                                                                                                                                 |
| Same / `prevents simultaneous menu and palette requests until the first finishes`                                                  | Two mounted hooks, deferred first result → command count one, both pending, release restores availability.                                                                                                                                                                                                                                                                                                           |
| Same / `rechecks a revoked local grant and never dispatches from a retained callback`                                              | Grant removed after render → no RPC, sticky local-permission reason. The success case's permission fixture throws on any remote permission read, proving the action requires the local grant only.                                                                                                                                                                                                                   |
| Same / `rechecks a removed saved connection and never fetches from a retained callback`                                            | Saved host deleted after render → no RPC.                                                                                                                                                                                                                                                                                                                                                                            |
| Same / `blocks a disabled host or a missing branch or project after the menu opened`                                               | Host disabled, branch null, project missing after callback capture → no command; visible guard reasons when context still qualifies.                                                                                                                                                                                                                                                                                 |
| Same / `uses a renamed current branch when the old palette callback runs`                                                          | Atom branch changes after callback captured → command uses new branch.                                                                                                                                                                                                                                                                                                                                               |
| Same / `shows server refusal or transport failure once and allows only an explicit retry`                                          | Inject the real 020 SshWorkspaceError values (source_not_found/ambiguous, invalid_branch/target, host_unavailable, invalid_remote_response, foreign_path, fetch_failed) plus authorization and socket Failure outcomes → actual error.message, timeout 0, no success/no auto retry, pending clears; user retry succeeds. Backend cause triggers are 020's fetch service activation matrix, not mocked backend proof. |
| Same / `clears pending after interruption without reporting success or retrying`                                                   | Interrupted Failure → no result toast, one dispatch, pending cleared.                                                                                                                                                                                                                                                                                                                                                |
| Same / `keeps fetch success when local status refresh fails without fetching again`                                                | Fetch Success then local refresh Failure → success ref remains, refresh error accurately names already fetched branch, one fetch and cleared pending.                                                                                                                                                                                                                                                                |
| Same / `retains fetch success and suppresses an interrupted local refresh error`                                                   | Interrupt local refresh after fetch Success → only success toast, no second fetch, pending clears.                                                                                                                                                                                                                                                                                                                   |
| Same / `uses bounded fallback copy for unstructured fetch or refresh failures`                                                     | Cause.fail string for each command → respective fallback description, no lower-level raw error string, no automatic retry.                                                                                                                                                                                                                                                                                           |
| Same / `keeps an in-flight result attributed to the original thread after navigation`                                              | Switch to another thread before deferred result → old scoped-thread toast, no second command.                                                                                                                                                                                                                                                                                                                        |
| `CommandPalette.logic.test.ts` / `makes the eligible action searchable by fetch and SSH`                                           | Real filter with fetch/ssh/local query → eligible value remains searchable.                                                                                                                                                                                                                                                                                                                                          |
| Same / `omits ineligible threads and excludes denied or pending actions from keyboard navigation`                                  | Hidden action or disabled item → null item / enabled itemValues empty, no Enter destination.                                                                                                                                                                                                                                                                                                                         |
| `GitActionsControl.test.ts` / existing branch/permission suite                                                                     | New hidden-hook mock → existing ordinary commit and metadata behavior still passes.                                                                                                                                                                                                                                                                                                                                  |

Primary-only integrated client pass, after explicit browser/computer-use authorization:
open an SSH-managed thread created by PR3, commit one remote change, open each shared
Git surface and the palette, fetch, and inspect the local returned ref. Record before/
after images of the action and the local-ref toast; inspect local HEAD/index/worktree
unchanged. Trigger disabled local grant, disabled saved host, disconnected local
environment and an SSH failure. Use two menu/palette entries during one pending
fetch to confirm a single invocation and visible pending state. Browser without bridge
and mobile must show no new SSH action. A remote branch rename must still fetch.
Only the parent performs this pass; no subagent server/browser is authorized here.

## Verifier commands and current-tree results (PLAN-VERIFIER-REAL-01)

All executions below used cwd
`/Users/jun/.goat/worktrees/goat/t3-8cf0da21` and prefixed:

```sh
PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
```

Each is scoped; no `vp check`, recursive checks, server or browser was run.
Commands are non-fixing. These results validate the present tree, not the planned diff.

| Exact executed command (PATH prefix as above)                                                                                                                                                                                                                                                                                                                                                  | Exit | Output / reads change target?                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test run apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/GitActionsControl.test.ts apps/web/src/components/CommandPalette.logic.test.ts`                                                                                                                                                                                                                   | 0    | 3 test files, 111 tests passed. Reads existing logic/control/palette test targets and their imported implementation. New hook/tests do not exist yet.                                                                                                                 |
| `vp run --filter @t3tools/web typecheck`                                                                                                                                                                                                                                                                                                                                                       | 0    | `~/apps/web$ tsc --noEmit`, cache disabled. `apps/web/tsconfig.json` includes src; reads existing web targets. New files will be included after creation. Does not check prose in user docs or this plan.                                                             |
| `vp lint apps/web/src/state/vcs.ts apps/web/src/components/GitActionsControl.tsx apps/web/src/components/GitActionsControl.logic.ts apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/GitActionsControl.test.ts apps/web/src/components/CommandPalette.tsx apps/web/src/components/CommandPalette.logic.ts apps/web/src/components/CommandPalette.logic.test.ts` | 0    | Reads all seven existing source/test change targets plus the existing VCS binding as dependency context. Existing React/compiler warnings and an unused `projectFavicon` warning; no lint failure. New hook/SSH binding/user docs are not covered by this invocation. |

After implementation, run the exact expanded proof set:

```sh
export PATH=/Users/jun/.goat/worktrees/goat/t3-8cf0da21/node_modules/.bin:$PATH
vp test run apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/GitActionsControl.test.ts apps/web/src/components/CommandPalette.logic.test.ts apps/web/src/hooks/useSshWorkspaceFetchBack.test.tsx
vp run --filter @t3tools/web typecheck
vp lint apps/web/src/components/GitActionsControl.tsx apps/web/src/components/GitActionsControl.logic.ts apps/web/src/components/GitActionsControl.logic.test.ts apps/web/src/components/GitActionsControl.test.ts apps/web/src/components/CommandPalette.tsx apps/web/src/components/CommandPalette.logic.ts apps/web/src/components/CommandPalette.logic.test.ts apps/web/src/hooks/useSshWorkspaceFetchBack.ts apps/web/src/hooks/useSshWorkspaceFetchBack.test.tsx
```

The expanded hook test/lint invocations are NOT RUN: new source/test targets do not
exist. Do not let passWithNoTests or a missing-file lint pass count as verification.
PR2 owns focused command permission/schema/service tests and its package typecheck;
rerun those if integration changes its implementation. The hosted exact-head goat-ci
gates are the parent's PR gate under 000/M6, not a replacement for focused proof.

Additional document check: a read-only Python stdlib check exited **0**: all nine
required sections present, balanced code fences, 26 existing-source anchors in range,
and PR2 command/payload names aligned. It reads this document and its cited source
files, so it covers the actual prose change target. It does not compile future code.

An attempted in-memory snippet parse using the installed
TypeScript package exited 1 because TypeScript 7.0.2's entrypoint exposes only version
metadata (`ScriptTarget`/`createSourceFile` unavailable). This is not a syntax verdict
on the planned code. The structural read-back check above replaces that optional
check; actual new code still needs the expanded test/typecheck/lint commands above.

## Commit plan and PR draft

Parent implementation commits, in order (no commit is made by this worker):

1. `feat(web): fetch SSH thread branches to this device` — eligibility, hook,
   menu/palette integration and focused tests in one behavior-complete commit.
2. `docs(user): explain SSH worktree transfer and fetch-back` — two concise sections.

PR title: `feat(web): fetch SSH worktree branches to this device`

PR body draft:

```md
SSH worktree threads run on their saved remote environment, but users have no direct
action to bring the committed branch back to the repository on this device.

Add Fetch branch to this device to the shared Git actions menu and command palette
for saved SSH environments with managed projects. The primary local environment
performs the guarded fetch, and the result toast shows the returned local ref.
Fetching preserves the local checkout and leaves the thread on its remote host.
Document the saved-host transfer and fetch-only workflow.

Validation: focused web action/eligibility/palette tests, web typecheck and scoped
lint; desktop before/after evidence: [UPLOAD LINKS BEFORE OPENING PR].

Stack map: [PARENT FILLS PR1 → PR2 → PR3 → PR4 LINKS].
Base: goat/ws-picker-3-ssh-ui. Landing follows 000/M6.

Model: [PARENT RECORDS ACTUAL IMPLEMENTATION MODEL]. Harness: Codex.
```

Replace evidence/model placeholders with actual implementation proof before opening
the PR; baseline verifiers in this document cannot be claimed as PR4 feature proof.
Upload PR-only images to GitHub, never commit them. Stack landing remains child-first
merge commits PR4→PR3→PR2→PR1, then final PR1→dev (M6); do not reinterpret this as
independent merges to dev or a rebase/squash workflow.

## Risks

- Re-anchor PR2/PR3 before implementing if their code changes. Keep the exact
  `sshWorkspaceFetchBack` member and `remoteWorkspaceRoot` payload documented in 020.
  No receipt/sourceProjectId input expansion.
- Thread branch metadata can lag a remote rename. The click-time read uses the latest
  known shell; an absent remote branch produces PR2's error, never a fabricated success
  or automatic retry to another branch. Refresh/reinvoke explicitly if needed.
- `.goat/repos` UI eligibility cannot prove the corresponding local source project
  still exists, or that a remote directory is managed. PR2 must perform both checks;
  test its refusal and preserve the user-facing error. UI remains a small projection.
- Fetch imports committed remote refs only. Remote uncommitted work must be committed
  first. A local project moved since launch cannot match the M3 root derivation.
- Saved environments can have several routes. Resolve the first valid saved SSH
  profile in preference order and preserve all target fields; alias-only reconstruction
  could fetch from the wrong host/user/port.
- Two UI entry points share one transient atom guard; this is duplicate-click handling,
  not durable exactly-once execution. PR2 must not add automatic retry.
- Existing lint warnings are baseline debt; unrelated cleanup stays outside this PR.
- This docs worker supplied no rendered/integrated proof. The parent's authorized
  desktop pass is still required before user-visible implementation completion.

## Plan conflicts

None identified in the examined current source. Current code has no fetch-back
contract/action yet, which is expected before PR2/PR4, not a contradictory decision.
The missing server explorer file is a disclosed input-evidence gap. Concurrent 020/030
are now available and their fetch-back dependency names were reconciled. AGENTS.md's
default against committed plans is already overridden by 000's task-specific authority;
no new override or reopened decision is proposed.
