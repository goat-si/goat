# 020 wp2 — why the Windows desktop on mini did not auto-update (read-only)

Class: C1 analysis, no code change unless a real defect is found (then a new unit).

## Flow to map with path:line (apps/desktop/src/updates)
- Poll: AUTO_UPDATE_POLL_INTERVAL "4 minutes" DesktopUpdates.ts:70; startup check + poll fibers DesktopUpdates.ts:1033-1066.
- Feed / prerelease: DesktopUpdates.ts:470-480 (allowPrerelease), channel settings updateChannels.ts.
- Download: coordinateAutomaticUpdate → downloadAvailableUpdate(true) when status available, DesktopUpdates.ts:956-958; download handler 1260-1300.
- Install policy default "restart-when-idle": updateMachine.ts:24, DesktopAppSettings.ts:85.
- Idle gate: backendActivity.probe DesktopBackendActivity.ts:51-129 — busy when any backend reports activity busy;
  unknown when activity endpoint fails, pid changed, WSL backend, or not ready. Install only on idle (DesktopUpdates.ts:968-1000),
  re-checked every 60 s (DesktopUpdates.ts:1024-1031).
- Quit path installs a downloaded update unless paused: DesktopLifecycle.ts:173-189.
- User-visible text: apps/web/src/components/desktopUpdate.logic.ts:158-181 ("Automatic restart postponed until backend work finishes." etc.)
  in Settings (SettingsPanels.tsx:319-360) — check whether the sidebar update button also shows "downloaded, waiting".
- Remote clients as activity: the Mac's threads running on mini's app server make mini's backend busy → postpones install.

## mini checklist (until wp1 ships and GOAT paths reach mini)
1. Settings → About/Updates on mini: status text, downloadedVersion, channel = nightly, policy.
2. Desktop update log on mini (the logs dir's desktop main log): "update downloaded" .317 / "Automatic update coordination failed".
3. Whether threads were running on mini at the time (busy) or activity unknown (WSL backend?).
4. After wp1 merges and ships: ssh.thread_launch/host-arg read of the same evidence via GOAT.



## Amendment A1
- Paths: apps/desktop/src/app/DesktopLifecycle.ts:173-189; apps/web/src/components/settings/SettingsPanels.tsx:319-360.
- Quit *attempts* installPrepared; it can be refused or fail (DesktopLifecycle.ts:183-188).
- Sidebar button tooltip (desktopUpdate.logic.ts:111-116) says "downloaded. Click to restart and install. It also installs when you quit GOAT."
  but not why it waits; only Settings text (desktopUpdate.logic.ts:170-173) names busy/unknown.
- Live evidence 2026-11-02 23:30Z (goat host.status mini): reachability ok since 23:29:46Z, serverVersion .314, compatibility compatible,
  protocol ssh 1001-1001 / orchestration 1001-1001, threads running 0, activity idle. Release .317 published 23:05Z.
  So "busy" is NOT shown by this sample; candidates remain: download not finished, check/download error, activity "unknown" from the
  desktop's own backend probe (DesktopBackendActivity.ts:83-121), or policy paused. Cause unproven until mini's desktop update state is read.


## Amendment A2 (live evidence 2026-11-03 00:26Z)
- goat-si/goat-releases: .314 published 11-02 07:55Z, .315 at 12:09Z, .317 at 23:05Z; .317 carries GOAT-…-x64.exe, -arm64.exe, nightly.yml.
- goat host.status mini at 00:26Z: serverVersion still .314, threads running 0 / activity idle, compatibility compatible.
- So mini skipped .315 for 12 h and .317 for 80 min while its server reports idle: a persistent condition, not a momentary busy postpone.
  Remaining candidates (each maps to code): policy "paused" (DesktopUpdates.ts:951-955) or install-on-quit (desktopUpdate.logic.ts:174-177);
  desktop-own backend activity "unknown" forever, e.g. a WSL backend (DesktopBackendActivity.ts:84-92) or activity endpoint/pid mismatch (93-115);
  updates disabled (DesktopUpdates.ts:259-281: no feed config, GOAT_DISABLE_AUTO_UPDATE); check/download error (errorContext);
  channel mismatch (coordinate returns when settings.updateChannel !== state.channel, DesktopUpdates.ts:949-950); or the served .314
  is not the desktop app's own server (probe found it as an unowned runtime under ~/.goat/runtime/goat/versions; the desktop server follows the app,
  remote-updates.md "The server embedded in the desktop app follows the app").
- GOAT read paths to mini's desktop state: none available now (host.process_history is local-only; storage.usage {host:"mini"} hung >90 s).
