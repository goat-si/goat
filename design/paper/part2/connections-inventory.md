# GOAT v1 Connections: every user-facing capability and state

Source: GOAT v1 `goat-si/goat` `origin/dev` `916b5ccc1b2`, read from code only (no screenshots, no running app).
Paths are under `apps/web/src/` unless noted. Purpose: the GOAT 2 "Machines" redesign (boards M1-M6, page
"Part 2 · 머신 연결") may restyle, merge or hide these behind a disclosure, but **must not drop any**. The last
column says where each item lives in the redesign.

Legend for "GOAT 2": M1-M6 = board; "Details" = behind the Details disclosure on that board; "menu" = the `…` menu
on that machine.

## A. Machine list and status

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| A1 | List of environments: this machine first, then saved remote environments | `settings/ConnectionsSettings.tsx`, `ConnectionEnvironmentsSection.tsx`, `SavedEnvironmentRows.tsx` | M1 sidebar |
| A2 | Row kind label: This machine / Local device / SSH `<target>` / Remote link / GOAT Connect | `EnvironmentRow.logic.ts` | M1 sidebar subtitle |
| A3 | Status: Connected, Connecting, Reconnecting (with reason), Unreachable, Connection failed (with error), Switched off, Not connected, Needs attention | `ConnectionsSettings.logic.ts:145-193`, `ConnectionStatusDot.tsx`, `fleet/fleetConnection.ts` | M1 sidebar dot + text; M6 |
| A4 | Pulsing dot while connecting/reconnecting | `ConnectionStatusDot.tsx:38` | M1 (static frame shows the reconnecting row) |
| A5 | Retry countdown "Retrying in 12s" | `EnvironmentConnectionProgress.tsx` | M6 |
| A6 | Runtime status line "Runtime ready · …", runtime tooltip | `ConnectionsSettings.logic.ts:154-172` | M2 Runtime section |
| A7 | Machine icon + kind: Server, Cloud VM, Linux/WSL, Desktop, Laptop, Mini PC, Workstation | `EnvironmentMachineIcon.tsx` | M1/M2 header icon; icon picker in M2 menu |
| A8 | Change icon (needs connection; old server can't keep icon; session may lack permission) | `settings/EnvironmentIconPicker.tsx` | M2 menu "Change icon" + its three messages in Details |
| A9 | Empty state "No saved remote environments" + how to add | `EmptyRemoteEnvironments.tsx` | M1 (sidebar section empty copy, rewritten) |
| A10 | Live load / threads per machine (fleet telemetry) | `fleet/fleetTelemetry.ts`, `fleet/FleetConsole.tsx` | M1 sidebar meta + detail stats; all machines in M7 |

## B. Versions and updates

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| B1 | Update available `{server} → {client}` per environment; Update / Retry update | `ConnectionEnvironmentsSection.tsx`, `ConnectionsSettings.tsx` | M2 banner; M1 list badge |
| B2 | Update all / Update everything | same | M1 top banner "2 machines need an update · Update all" |
| B3 | Downloading update {v}, Update {v} downloaded, Up to date | `ConnectionsSettings.logic.ts` | M1 This Mac "GOAT version" row |
| B4 | Primary version mismatch: "Update to {clientVersion}" | `ConnectionsSettings.tsx` | M6 version row |
| B5 | SSH runtime: Update runtime / Update now, "Running agent work gets up to a minute to finish, then continues on the new version", Couldn't update, Refresh status | `SshRuntimeSettingsRow.tsx` | M2 Runtime section |

## C. This machine (local)

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| C1 | Local environment on/off ("Run agents on this computer"), confirm dialog, restarting, turned-off state | `LocalEnvironmentSetting.tsx` | M1 "Run agents on this Mac" switch |
| C2 | Network access: enable/disable (confirm, restarts GOAT), exposure states (Limited to this machine / Exposed on all interfaces / Reachable at …), port 1-65535, "can't change where the server starts" | `ConnectionsSettings.tsx` | M1 "Let other devices connect" + Details (port, interfaces) |
| C3 | Tailscale HTTPS: set up / disable (confirm, restarts), HTTPS endpoint, pending MagicDNS, "Start Tailscale…", "Turn on Network access to detect Tailscale", Tailscale guide | `ConnectionsSettings.tsx`, `.logic.ts` | M1 Details "Tailscale HTTPS" |
| C4 | Reachability groups: Devices on the same network / private network / Reachable from anywhere / Opens the hosted app | `ConnectionsSettings.logic.ts` | M1 "Reachable from" chips |
| C5 | WSL backend (Windows): run both / WSL only / switch distro / disable, errors | `ConnectionsSettings.tsx` | M1 Details (shown only on Windows; noted on board) |
| C6 | Worktree checkouts setting, Primary environment | `ConnectionsSettings.tsx` | M1 Details |
| C7 | Authorized clients list; revoke one; revoke all others (+ caveats about desktop credential/Pen sessions) | `ConnectionsSettings.tsx`, `.logic.ts` | M1 "Devices that can connect" list + menu "Revoke all others" |
| C8 | Create pairing link / pairing code; copy once ("It will not be shown again"); revoke pairing link | `SavedEnvironmentAccessView.tsx` | M5 left |
| C9 | GOAT Connect: coming soon / enable / sign in / linked / out of sync / unlinked, tunnel disabled | `SavedEnvironmentRows.tsx`, `cloud/linkEnvironment.ts` | M1 Details "GOAT Connect · Coming soon"; M6 out-of-sync |
| C10 | Publish agent activity to mobile notifications / Live Activities (sign in) | `SavedEnvironmentRows.tsx` | M1 "Phone notifications" switch |
| C11 | Hold webhook requests up to 24 h while offline | `SavedEnvironmentRows.tsx` | M1 Details |
| C12 | Copy MCP URL, Copy trace ID, Copy diagnostic | `ConnectionEnvironmentsSection.tsx` | M1/M2 menu |

## D. A remote machine

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| D1 | Routes to a machine, preferred first; In use; reorder; remove (confirm); Add route; "Sign-in refused — pair this address again" | `EnvironmentRoutesList.tsx` | M2 "How GOAT reaches it" |
| D2 | Add a route to an existing machine (pair again over another address; joins, no second machine); GOAT Connect fallback route | `ConnectionEnvironmentsSection.tsx` | M2 "Add another way" |
| D3 | Switch on / Switch off (keeps it saved, reconnects when GOAT starts) | same | M2 header switch |
| D4 | Remove from this device (forgets pairing, credentials, cached threads) | same | M2 menu → confirm (copy on board) |
| D5 | Forget host (SSH): removes SSH entry + pinned key GOAT added, stops server when idle; your own config stays | same | M2 menu |
| D6 | Service access / permissions: View environment, Read/Write files, Use/View terminals, Operate tasks, Control previews, Change source control, Manage providers, Change environment settings, Maintain environment, View/Manage access, View/Manage relay, View diagnostics and usage, Open hub devices; checking / could not verify / not accepted | `connectionPermissionMessages.ts`, `SavedEnvironmentAccess(View).tsx` | M2 "What this Mac can do there" (grouped, full list in Details) |
| D7 | Diagnosis: headline, steps "What to try", Retry now, Copy diagnostics, Add direct route, More info, Not checked | `ConnectionDiagnosisDetails.tsx` | M6 |
| D8 | Remote launches: threads launched on other hosts, Launched by, Open, Not started, Outcome unknown, Host unreachable for {t}, not connected (connect over SSH / pair), dismiss | `RemoteLaunchesSettings.tsx` | M2 "Work started from here" |
| D9 | Device saved here but not added to hub | `ConnectionEnvironmentsSection.tsx` | M6 small notice |
| D10 | Client not supported | `ConnectionsSettings.logic.ts` | M6 |
| D11 | Permission: "This device can't set up hosts on this environment. Ask its owner for full access."; Manage settings needed to check a host | `ConnectionEnvironmentsSection.tsx` | M6 |

## E. Add a machine

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| E1 | Add device chooser: SSH (this device's SSH settings), GOAT server on your tailnet (pairing), GOAT Connect (coming soon) | `ConnectionEnvironmentsSection.tsx` | M3 |
| E2 | SSH hosts discovered "From ~/.ssh/config" + known_hosts, search "Search hosts or type devbox", "No hosts match", loading hosts | same, `ConnectionsSettings.logic.ts` | M3 SSH card + M4 |
| E3 | Add new SSH hosts from the machine that runs this environment | same | M3 footnote |
| E4 | Pending SSH add row: Adding over SSH, Couldn't add, Retry, Dismiss, "already adding" | `PendingSshAddRow.tsx`, `pendingSshAdds.ts`, `runSshAdd.ts` | M4 + M1 sidebar pending row |
| E5 | SSH preflight checklist steps: Connection, Host key, SSH key sign-in, Operating system, Disk space, GOAT runtime; states waiting / passed / needs review / failed / not checked; fix hints per failure; Copy command; Check again; Forget host | `SshPreflightChecklist(.logic).tsx`, `sshPreflightMessages.ts` | M4 |
| E6 | Trust this SSH host? review fingerprint; host key changed warning; already in known_hosts → approve once | same, `SshRuntimeSettingsRow.tsx` | M4 host key row + Details |
| E7 | Copy public key / Copy setup command (key sign-in fix) | `SshRuntimeSettingsRow.tsx` | M4 |
| E8 | SSH password / verification code prompt; expired prompt | `desktop/SshPasswordPromptDialog.tsx` | M4 sheet |
| E9 | "GOAT is ready on {host}, but the connection couldn't be saved" | `runSshAdd.ts` | M6 |
| E10 | Pairing: paste link or code ("fills both fields"), host + pairing code fields, validate, "This link adds a backend… continue only if you trust it", Pairing…, Backend paired, Open app | `PairingRouteSurface.tsx`, `PairingLinkConnectFlow/Target.tsx`, `pairingUrls.ts` | M5 right |
| E11 | Pairing errors: token already submitted, invalid backend host, missing host/token, authentication failed, desktop-managed environment | `PairingRouteSurface.tsx` | M5 error line + M6 |
| E12 | Cloud machines (GOAT Connect / cloud rows) | `CloudRemoteEnvironmentRows.tsx`, `cloud/linkEnvironment.ts` | M3 "Cloud machine" card (Coming soon, as v1) |

## F. Storage problems

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| F1 | Saved environments couldn't be unlocked (another GOAT app's key) / file damaged / secure storage unavailable / changed by another app | `desktop/ConnectionCatalogUnreadableNotice.tsx` | M6 |
| F2 | Start fresh (confirm; keeps a backup copy at path), Starting fresh…, Could not start fresh | same | M6 |

## G. Fleet (overall view, owner request 2026-11-29: bring v1 Fleet in, never load everything at once)

| # | Capability / state | v1 source | GOAT 2 |
|---|---|---|---|
| G1 | Fleet summary: machines online / idle ("Idle: {machines}"), threads running, "Nothing running on N machines" | `fleet/FleetPage.tsx` | M7 header line |
| G2 | Per-machine telemetry: load 1m, memory, disk, heat tiers, stale values faded, "No metrics", "Update GOAT to report" | `fleet/FleetConsole.tsx`, `fleetTelemetry.ts` | M7 machines table (bars, "Update GOAT to report") |
| G3 | Alerts with actions: under heavy load, low / almost out of disk (Free up space, Clean up), unreachable (Retry connecting), different GOAT version, compacting history, cloud machine running empty and billing (Stop), "Need you" / "All clear" | `fleet/FleetAlertAction.tsx`, `fleetTelemetry.ts` | M7 "Needs you" list |
| G4 | Still connecting / Reading hosts… / Checking SSH hosts and cloud machines… | `FleetPage.tsx`, `FleetGraph.tsx`, `FleetConsole.tsx` | M7 skeleton row "Still connecting" |
| G5 | Uncounted hosts: "Only GOAT servers that answer are counted." | `fleet/FleetUncountedHosts.tsx` | M7 table footnote |
| G6 | Quota per provider: headroom, next reset, OpenCodex pool, quota unknown, routing inferred | `fleet/fleetQuota.ts`, `FleetConsole.tsx` | M7 "Usage limits" |
| G7 | Thread list per machine; select a machine to show only its threads; Show all; "Needs you"; last reported by | `fleet/FleetThreadList.tsx`, `FleetPage.tsx` | M7 "Threads on <machine>" (lazy, 20 at a time) |
| G8 | Subagents under threads | `fleet/FleetSubagents.tsx` | M7 thread rows (expand) |
| G9 | Hub summary: OpenCodex Home version, hub devices, relay warnings, hub settings | `fleet/FleetHubSummary.tsx` | M7 "OpenCodex Home" card |
| G10 | Cloud agents (open, link only) | `fleet/FleetCloudAgents.tsx` | M7 card |
| G11 | Fleet graph (this machine center, machines, threads, legend by status and heat) | `fleet/FleetGraph.tsx`, `FleetPage.tsx` | M7 "Graph" toggle (graph board to draw next; same lazy data) |

Total: 63 items (A10 + B5 + C12 + D11 + E12 + F2 + G11). All placed; none dropped.
