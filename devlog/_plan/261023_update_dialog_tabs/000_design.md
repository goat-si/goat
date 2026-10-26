# 000 — Update dialog: App & servers / Runtimes

> Written 2026-10-23 · base origin/dev 23901144a · branch feat/update-dialog-tabs

## Problem

The sidebar update button opens one "Update N providers?" alert that mixes this Mac's app, remote
GOAT servers and provider CLIs in one text list. Server updates send `confirmReplacement: true`,
so a busy remote server restarts under running turns. SSH runtimes are skipped with "update its
runtime in Settings → Connections", and managed OpenCodex (#727) is invisible.

## Research (read 2026-10-23 through Aside code mode unless noted)

| Source                                                                                                            | What it says                                                                                                                                                                                                                    | Decision it drives                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [WAI-ARIA APG, Tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)                                      | `tablist`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`/`aria-labelledby`; arrow keys move between tabs; automatic activation is fine when panels show without delay; a panel without focusable content gets `tabindex=0`. | The two views switch whole panels, so they are real tabs (Base UI Tabs), styled like the segmented control. |
| [Apple HIG, Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls) | Equal-width segments, text or images (not both), for closely related choices that change a view.                                                                                                                                | Two equal-width text tabs; the count is plain text beside the label, no icons.                              |
| [NN/g, Tabs, Used Right](https://www.nngroup.com/articles/tabs-used-right/)                                       | In-page tabs switch related views without leaving the page; unselected tabs must stay noticeable.                                                                                                                               | Both tabs live in the dialog; each shows its own count so the inactive one is not forgotten.                |
| [VS Code, Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions) (web search)    | The remote server is matched to the local client's commit and installed or updated on connect.                                                                                                                                  | Every connected server is matched to this Mac's version; SSH runtimes follow this app.                      |
| [JetBrains, Update IntelliJ IDEA / Toolbox](https://www.jetbrains.com/help/idea/update.html) (web search)         | Toolbox shows per-tool updates with "Update all", and the channel (Release/EAP) is a per-tool setting.                                                                                                                          | Checkbox per row with all selected by default; this Mac's row names its channel.                            |
| [Tailscale, Update clients](https://tailscale.com/docs/features/client/update) (web search)                       | The machines list flags which devices have an update; remote update is mostly auto-update policy, not an instant push.                                                                                                          | Per-row version → target; managed OpenCodex is shown as an automatic update you can ask to check now.       |

## Decisions

1. **Two tabs, one dialog.** "App & servers" and "Runtimes", each labelled with its selected count. The
   footer button reads "Update N" for the active tab and is disabled at 0. The sidebar button stays one
   control; its tooltip names both tabs' counts. Managed OpenCodex is not in the sidebar count, because
   reading it needs a host-status read that costs a 200 ms CPU sample, so it is read only while the
   dialog is open.
2. **Order: remote first, this Mac last.** Remote servers and SSH runtimes start together; this Mac's
   install waits until every remote one has handed off, settled or is still waiting, then restarts last.
3. **Never interrupt running turns.** Server self-updates drop `confirmReplacement`. A host with running
   threads shows "waiting for idle"; the client starts it when its running count reaches 0, and retries a
   server-side busy rejection after a minute. SSH runtimes use `when_idle`, the #683 path, whose own
   wait shows as waiting. This Mac also waits for its own running threads before the restart countdown,
   and the capsule offers **Restart now** for a person who chooses to interrupt. **Stop waiting** drops
   waiting hosts from the run (the way out of a wait).
4. **Partial selection.** Every row has a checkbox, all on by default. Skipped hosts are one muted
   line per host with the reason, never a checkbox.
5. **Runtimes tab.** Provider updates per host (existing one-click candidates), then OpenCodex. The
   OpenCodex row appears when the Home reports managed-update status; it is selectable only when an
   update is due and waiting, and Update calls a new `server.checkOpenCodexUpdate` that runs the
   coordinator's check now (Home first, then Children, with its own idle wait and probation). The
   staged rollout still applies; the row says when the rollout has not reached this Hub yet.
6. **Results.** The existing capsule keeps per-host progress: waiting / updating / done / failed with
   Retry, plus the new waiting state.

## Contract

- `server.checkOpenCodexUpdate` (payload `{}`, success `NullOr(OpenCodexUpdateStatus)`), guarded by
  `environment:maintain` in `CLIENT_GUARDED_RPC_SCOPES`. Older servers do not offer it; the row then
  only reports status.
- `OpenCodexManagedUpdate.checkNow`: clears the next-check timer and runs `check` under the same
  one-permit semaphore as the scheduler, so a manual check cannot open a second window.

## Files

- packages/contracts/src/rpc.ts, clientRpcPermissions.ts — new method
- apps/server/src/hub/OpenCodexManagedUpdate.ts (+ test), apps/server/src/ws.ts, observability/RpcInstrumentation.ts
- packages/client-runtime/src/state/server.ts — `checkOpenCodexUpdate` command
- apps/web/src/components/ui/tabs.tsx — Base UI Tabs with the segmented look
- apps/web/src/components/sidebar/updateEverything.logic.ts (+ test) — tab plans, ordering, idle loop
- apps/web/src/components/sidebar/useUpdateEverything.ts, UpdateEverythingDialog.tsx (+ browser test),
  updateEverythingRun.tsx, SidebarUpdateCapsule.tsx, SidebarUpdatePill.tsx, ServerUpdateAction.tsx
- docs/user/updating.md

## Acceptance

- Logic tests: remote targets before this Mac; idle gate waits for 0 running threads, retries a busy
  rejection, stops on Stop waiting; channel mismatch skip; skip reasons; tab counts follow selection.
- Server test: `checkNow` runs a check before the timer is due and never overlaps the scheduled check.
- Browser test: switching tabs changes the button label and count; unchecking a row lowers the count.
- Before/after captures, light and dark, at 360 px width.
