# next3 N10 service, update and release (lane record)

Lane branch: chase/t3-261114-next3-n10-service-release, cut from origin/chase/t3-261114-next3 at 259883c788bb32d5601023932e07f879bde9af60 (git rev-parse HEAD on the lane worktree; equals the brief). Thread host: pen-mac-studio (juns-Mac-Studio.local). Rows: the C12 chain (d0d0608b6b with e805ce3712, 26433ac070, 99224f098d, f6b260df15 without the Windows part, a25654c396), C17, C20, C19, O25, goat#3579. Class: C4 lane, size L. State: PLAN ONLY, no code commit, nothing pushed to a code branch. Code waits for the coordinator's ruling on this plan and for K5's review to be through (the coordinator's placement: N10 follows K5 on pen-mac-studio).

## What the row names mean (sources)

The #3176 line numbers in next2-pr-plan.md:31 are three lines lower in today's body (the checklist grew); the shas decide.

| name | upstream commit | #3176 line today | ruling (quoted from #3176, decided 2026-11-15/16) |
| --- | --- | --- | --- |
| C12 (L130) | d0d0608b6b "a remote update points the service unit at the runtime it committed" with e805ce3712 "Update server works again on services installed before the launcher protocol bump" | 133 | "A, one launcher-protocol-4 lane: d0d0608b6b with e805ce3712 first, then 26433ac070, 99224f098d, f6b260df15, then a25654c396 (coordinator ruling C12). Conditions: the launcher-protocol-4 lane is C4 with its own review guide (every pairing of launcher 3 or 4 with server 3 or 4, an interrupted selection write, a downgrade); a25654c396 runs reconcileGoatMigrationIds before preflight; 93c10239b4 (Windows service) is not in this lane and is held for the owner" |
| C12 (L216) | 26433ac070 "boot service log is emptied in place once it passes 10 MiB" | 219 | in the chain after d0d0608b6b |
| C12 (L219) | 99224f098d "launcher repoints the unit the systemd manager loads" | 222 | in the chain after d0d0608b6b |
| C12 (L133) | f6b260df15 "self-update moves the t3 command to the new runtime", without the Windows part | 136 | in the chain; 93c10239b4 stays with the owner |
| C12 (L515) | a25654c396 "block incompatible migration history in preflight" | 521 | last in the chain; "must run or simulate reconcileGoatMigrationIds before the preflight" |
| C17 | 034f3ba918, its rollback half only | 216 | "A, the rollback fix now (coordinator ruling C17). The online copy stays open as its own item (needs an ownership design; not started)." The rollback half: "restore -wal and -shm beside the database's real file and remove the copies beside a symlink" |
| C20 | 44ee2b9c34 "restart the service after T3 home ownership clears" | 221 | "A, stay pending and poll every 30 s, give up after 10 minutes with the existing db-owner-busy failure shown (coordinator ruling C20). Authorised test edit: 'serviceLauncher.test.ts:340 may be rewritten to expect the update to stay pending while the home is owned, to restart once ownership clears, and to fail visibly with db-owner-busy at the 10-minute bound.' TestClock only." |
| C19 | 7eca0ed885 "hand-started t3 servers get an update command that updates them" | 220 | "A, add the goat-launcher variant (coordinator ruling C19). Condition: an older-client decode test showing it reads as absent." |
| O25 | e07585e5fb "AppImage updates keep their filename" | 447 | owner, 2026-11-16: "A, version-free AppImage names and an updated release verifier." next2-pr-plan.md:31: "O25's in-place update is proven only by a real release" |
| goat#3579 | GOAT-own | - | owner (next-N13a.md:97): "그대로 머지 (크기 증가 수용, 중복 사본 줄이기는 후속 이슈로)"; the issue: measure, then reduce the copies |

O25 is not written as "O25" anywhere on the records branch or in #3176; it is the 25th owner decision in #3176's line order (O24 = L429 react-native-screens, O26 = Effect 4.1 at :463, O28 = L461), and e07585e5fb is the only owner-decided release row between them. The coordinator should confirm this reading (decision D6).

## Ancestry check (#3519 = 3ecea04f19, #3660 = 42bf8633ce; integration head 259883c788 contains dev 8c59f73519)

Commands: `git log origin/chase/t3-261114-next3 -i --grep=<sha>` (only record mentions: 3182a54238 and 987b7ab6d3 name a25654c396, 034f3ba918, 7eca0ed885, e07585e5fb as deferred), then the code on 259883c788:

| row | carried? | evidence on 259883c788 |
| --- | --- | --- |
| d0d0608b6b + e805ce3712 | no | apps/server/src/cloud/serviceProtocol.ts:4 `SERVICE_LAUNCHER_PROTOCOL = 3`; no serviceSelectionLock.ts; serviceLauncher.ts has no unit repoint (rg "repoint|serviceUnit" 0 hits); decodeServiceLauncherContext accepts only protocol 3 (serviceProtocol.ts:256-262) |
| 26433ac070 | no | no SERVICE_LOG_MAX_BYTES or log truncation in serviceLauncher.ts (rg "truncat" 0) |
| 99224f098d | half | the installer half exists: cloud/systemdUnitDirectory.ts (readSystemdUnitDirectory over busctl, from #3212/#3266) used by bootService.ts:604, :930. The launcher half (find the loaded unit) is absent with the rest of d0d0608b6b |
| f6b260df15 | no | no repointLaunchers; prepareTrial is a value (serviceLauncherClient.ts); the installer reads GOAT_INSTALL_BIN_DIR (cli/update.ts:326, pinnedRuntime.ts:518) but the unit does not carry it |
| a25654c396 | no | servicePreflight.ts (64 lines) checks only the launcher protocol; it never reads the database. GOAT never had upstream's newerRecordedMigrations (git log -S 0 hits). The pure pieces it needs exist: goatMigrationIdsMove, displacedUpstreamMigrations, skippedV2Migrations (persistence/reconcileGoatMigrationIds.ts:90, :105, :148) |
| C17 034f3ba918 rollback half | no | restoreDatabaseBackup restores each suffix at restoreTarget(`${pending.dbPath}${suffix}`) (serviceLauncher.ts:375-381): for a symlinked database the -wal/-shm path is the non-link sibling, so the copy lands beside the link, where SQLite never reads it |
| C20 44ee2b9c34 | no | #idleWhileRefused records the pending update failed at once (serviceLauncher.ts:997-1008); no owner poll |
| C19 7eca0ed885 | no | ServerInstallation has only npx/pnpm-dlx/bunx and npm-global (packages/contracts/src/environment.ts:75-78) |
| O25 e07585e5fb | no | artifactName "GOAT-${version}-${arch}.${ext}" (scripts/build-desktop-artifact.ts:2998); the verifier expects versioned names (scripts/lib/release-verify.ts:500-501, :523, :537, :744) |
| goat#3579 | no | open; @betteroffice/fonts-cjk 0.4.0 in apps/web/package.json:20 |

Nothing is ticked as covered.

## Measurement already in hand for goat#3579 (read-only, gh release view)

Published assets, nightly .371 (42119a73e4, before #3519) against nightly .376 (6f872e6b2d, after; v0.1.10 stable is the same commit):

| asset | .371 bytes | .376 bytes | growth |
| --- | --- | --- | --- |
| x86_64.AppImage | 724,127,755 | 858,002,412 | +133.9 MB |
| arm64.dmg | 708,785,495 | 843,374,258 | +134.6 MB |
| x64.exe | 842,237,227 | 1,005,702,042 | +163.5 MB |
| linux-x64 CLI tar.gz | 168,871,544 | 202,056,726 | +33.2 MB |

The growth is all of #3519, not only the fonts; step 1 of the row attributes it by listing the font files inside one CLI archive and one installer.

## Upstream code read for the plan (facts the rows rest on)

- d0d0608b6b normalises every decoded state to protocol 4 (upstream main serviceProtocol.ts:255) and the launcher writes the child context with `protocol: SERVICE_LAUNCHER_PROTOCOL`. A protocol-3 runtime rejects any context whose protocol is not 3 (GOAT serviceProtocol.ts:256-262), and resolveStartup fails with decode-context (serviceLauncherClient.ts:133-135), so that runtime's server does not start. repointServiceUnit never moves a unit to an older version ("A unit already at that version or a newer one is returned unchanged"). So: commit N to N+1, the service restarts within probation (reboot), the unit now runs N+1 as a protocol-4 launcher, N+1 fails to start, the launcher rolls back to N (protocol 3) and starts it with a protocol-4 context. N refuses, the launcher keeps restarting it, and the unit still names N+1. That is the "downgrade" case of ruling C12; see D1.
- e805ce3712 lets a protocol-4 runtime run under a protocol-3 launcher. The child passes its launcher's protocol to the target's preflight. A protocol-3 launcher takes no lease and repoints nothing (documented upstream).
- 034f3ba918's backup side is unchanged upstream: backupDatabaseOnce copies `${pending.dbPath}${suffix}` (GOAT serviceLauncher.ts:264-268, upstream main :552-556), so a symlinked database's live WAL is not backed up. See D2.
- 44ee2b9c34 polls without a bound and needs two free probes in a row; ruling C20 adds the 10-minute bound.
- f6b260df15's Windows part: the win32 branch of repointLaunchers (it returns early off linux/darwin) and the scheduled-task representation from 93c10239b4. GOAT ports only the linux/darwin branch.
- e07585e5fb's packaging/aur changes have no GOAT counterpart (no packaging/ directory).

## Rows, in order

Every row: one commit, the failing test shown before the fix, the at-entry move-out committed (verbatim) before the row that needs it. GOAT names replace upstream's: goat, GOAT_HOME, GOAT_BOOT_SERVICE_UNIT with its legacy T3 name through bootServiceEnvNames (bootService.ts:68), the runtime executable `goat` (pinnedRuntime.ts:76), the si.goat.service label.

### 0. Verbatim move-outs (claims for the card's table, sent before any cut)

| file | block (on 259883c788) | to | about |
| --- | --- | --- | --- |
| apps/server/src/serviceLauncher.ts (1086 = entry) | :80-106 DB_FILE_SUFFIXES..pathExists and :139-402 syncFile..discardDatabaseBackup (backup space, backup, restore target, restore, discard) | apps/server/src/serviceLauncherDatabase.ts (re-export of databaseBackupBlocker, BackupSpaceProbe for existing importers) | 290 |
| apps/server/src/cloud/bootService.ts (1358 = entry) | :388-487 BootServiceUnsupportedError..BootServiceError union | cloud/bootServiceErrors.ts (re-export) | 100 |
| apps/server/src/serviceLauncher.test.ts (1568 = entry) | :1164-1387 top-level describe "post-update health", whole (IV (vi)) | serviceLauncher.health.test.ts | 224 |
| scripts/build-desktop-artifact.ts (4782 = entry) | the Mac passkey block around :1236-1338 (its error classes, normalizePasskeyRpDomain, resolveMacPasskeySigningConfiguration), exact lines in the commit | scripts/lib/mac-passkey-signing.ts (re-export) | 100 |
| apps/server/src/server.ts (1294 = entry) | one self-contained block of at least 5 lines with no local dependencies, named with exact lines before C19 is cut | a server-owned module (re-export) | 10 |

New tests go into new files (serviceSelectionLock.test.ts, serviceLauncher.unit.test.ts, bootService.selection.test.ts, build-desktop-artifact.appImage.test.ts, release-verify.appImage.test.ts), so bootService.test.ts (1272 = entry), build-desktop-artifact.test.ts (3017 = entry) and release-verify.test.ts (988, cap 1000) need no move-out. Each length is re-measured with countLines before its commit, and no entry is raised.

### 1. C17: rollback restores -wal/-shm beside the real database file (034f3ba918, rollback half)

Changes: restoreDatabaseBackup resolves the main file once (restoreTarget(dbPath)), restores -wal and -shm beside that resolved file, and removes stale copies beside the link. The online-copy half stays open. Files: serviceLauncherDatabase.ts (after move-out), serviceLauncher.unit.test.ts. Stored data: a rollback of a symlinked database now writes the real file's siblings. Older/newer: launcher-internal; no wire. Negative cases: a database that is not a link (paths unchanged), a dangling link (restoreTarget's existing walk), a backup without -wal (the real-side -wal is removed, as today for the link side). Fail first: a symlinked database with a WAL beside the real file; after a rollback the real-side -wal holds the backup's bytes and the link-side copy is gone (fails today: the copy lands beside the link). Size S.

### 2. C12 part 1: launcher protocol 4 with protocol-3 acceptance (d0d0608b6b + e805ce3712, one commit)

Changes: serviceSelectionLock.ts (new, upstream's lease); SERVICE_LAUNCHER_PROTOCOL 4 with SupportedLauncherProtocol = 3 | 4; the launcher serialises state writes under the state lease (#selectState) and refuses further updates once a local command changed its selection. After a commit or rollback it repoints the unit that started it (found by GOAT_BOOT_SERVICE_UNIT and its legacy name) at the selected runtime and reloads the manager, best effort. The installer takes the state lease, then the unit lease, and BootServiceUpdatePendingError carries a recovery command when the unit is gone. The child names its launcher's protocol to the target's preflight. Docs: docs/internals/server-updates.md (rewrite the affected paragraphs), docs/user/updating.md (one sentence on a declined restart). Files: cloud/serviceSelectionLock.ts, cloud/serviceProtocol.ts, serviceLauncher.ts, a new serviceUnitRepoint.ts for ServiceUnit, serviceUnitFromEnvironment and repointServiceUnit (keeps serviceLauncher.ts under its entry), cloud/bootService.ts, cloud/servicePreflight.ts, cloud/selfUpdate.ts, cloud/serviceLauncherClient.ts. The repoint regex matches GOAT's `/runtime/versions/<v>/goat` (and the legacy `/t3` program a migrated unit may still name).

Pairings (each a test; launcher Lx = the runtime systemd or launchd starts, server Sx = the child):

| launcher | child | what happens | test |
| --- | --- | --- | --- |
| L3 | S3 | today | existing suites unchanged |
| L3 | S4 | the first remote update after this lands: S4 accepts context protocol 3, names launcher protocol 3 to preflight, the update commits; L3 takes no lease and does not repoint the unit (upstream documents it) | serviceLauncherClient: protocol-3 context decodes; selfUpdate: preflight gets "--launcher-protocol 3" and accepts a ready reply naming 3 |
| L4 | S4 | leases, repoint after commit and rollback, refusal after a local selection change | upstream's cases, in new files |
| L4 | S3 | after a probation rollback to a pre-bump runtime under a restarted L4 launcher (above): S3 rejects the context today | a fail-first test with a protocol-3 decoder; the fix waits on D1 |

Interrupted selection write: a launcher killed holding the lease (lease from a dead PID or an earlier boot is reclaimed; upstream's test plus a dead-PID case); an installer that wrote state but not the unit (the unit lease is not taken by the launcher while it holds state; the next launcher start retries the repoint); a crash between state write and repoint leaves the unit at the old runtime, and the next start after a finished update repoints it. Downgrade: `goat service install --allow-downgrade` to an older version writes state with that version's protocol and repoints the unit; a protocol-3 launcher reading a state file that a protocol-4 writer left behind is D1's second half. Stored data: service-state.json protocol field, and the unit file's ExecStart is rewritten in place (durable rename). Older client/server over the WebSocket: no change (no contract moves).

Fail first: the lease reclaim test; "a committed update repoints the unit that started the launcher" (fails today: the unit still names the old runtime); "a protocol-4 runtime runs under a protocol-3 launcher" (fails after the bump without e805ce3712's acceptance, so it is shown failing on the intermediate tree inside the same commit's work, and both outputs are recorded). Size L.

### 3. C12 part 2: the boot service log is bounded (26433ac070)

Changes: the launcher finds the log through its unit (StandardOutput=append: or StandardOutPath), copies it aside to .1 and truncates in place above 10 MiB, checked at start and every 10 minutes. Files: serviceProtocol.ts (serviceUnitLogPathOf), serviceUnitRepoint.ts or a small serviceLog.ts, serviceLauncher.ts. Negative: full disk (truncate still runs), unreadable unit (no bound, no crash). The timer is unref'd and injected, and tests drive it without wall-clock waits. Fail first: a 10 MiB + 1 log is truncated with its copy at .1. Size S.

### 4. C12 part 3: the launcher repoints the unit the systemd manager loads (99224f098d)

Changes: the launcher asks busctl for UnitPath (the manager's own environment can differ from the service's) and falls back to XDG_CONFIG_HOME. GOAT moves systemdUnitDirectoryOf into serviceProtocol.ts beside the installer's Effect reader (systemdUnitDirectory.ts), one parser for both. Negative: busctl missing or failing (fallback), a UnitPath without a control directory (fallback). Fail first: a fake busctl reply with an overridden unit directory decides the repointed path. Size S.

### 5. C12 part 4: an update moves the goat command to the new runtime (f6b260df15 without the Windows part)

Changes: when the launcher commits a trial, the child repoints owned `goat` symlinks (GOAT_INSTALL_BIN_DIR or ~/.local/bin, and the first `goat` on PATH) that point into this home's versions directory. The unit records GOAT_INSTALL_BIN_DIR when the installer had one. prepareTrial takes { baseDir }. linux and darwin only; win32 returns early as upstream. Negative: a link outside the versions directory (left alone), a regular file (left alone), a link elsewhere on PATH that points at another home (left alone), an interrupted rename (temp-dir link plus rename, so the old link stays valid). Fail first: upstream's cases in serviceLauncherClient.test.ts (new describe at the end of a new file). Size M.

### 6. C20: the service restarts after home ownership clears (44ee2b9c34 with the ruling's bound)

Changes: on exit 78 (state-dir-owned) the launcher stays idle and probes ownership every 30 s (lock, then a live pre-lock server-runtime.json owner, through legacyServerOwner.ts shared with serverOwnership.ts). After two free probes in a row it starts again: the pending update's trial, or the active version. A pending update that is still blocked after 10 minutes is recorded failed with reason db-owner-busy and its backup discarded; the launcher keeps probing to start the active version (see D3). Exit 79 (database-ahead) keeps today's behaviour. serverOwnership's exclusive probe waits 250 ms (busy_timeout) to ride out the launcher's own probe. The clock and interval are injected into Launcher (no Effect runtime in the launcher), and tests advance them by hand, with no sleeps. Rule 3: serviceLauncher.test.ts:340 rewritten exactly as authorised (pending while owned, restart once free, db-owner-busy at the bound). If :297 "stays idle when the active server refuses with $code" changes for code 78, it comes to the coordinator first with before and after. Negative: the owner frees and returns between probes (counter resets), a stop request during a probe, a pre-lock owner whose PID was reused (start-time check). Size M.

### 7. C12 part 5: preflight blocks an incompatible migration history (a25654c396)

Changes: __service-preflight reads the recorded migration ids read-only and simulates startup's reconciliation: goatMigrationIdsMove (GOAT ledger ids) first, then the V2 preview reconciliation (upstream's reconciledV2PreviewHistory, a pure extraction of reconcileV2PreviewMigration.ts), then blocks on ids newer than the build head or skipped V2 ids. The message names them, as upstream does. A database that does not exist yet is ready; an unreadable one is blocked, as upstream. Files: cloud/servicePreflight.ts, persistence/reconcileV2PreviewMigration.ts, persistence/Migrations.ts (export only if needed). Older/newer: the preflight reply format is unchanged ({status, version, reason}); an older server reading a "blocked" reply already shows its reason. Negative: a GOAT ledger at pre-move ids that reconciliation fixes (ready, not blocked), a recorded V2 preview at 53 or 54 (ready), a history with a skipped id (blocked), a newer build's ids (blocked). Fail first: the GOAT-ledger case and the skipped-id case (today the preflight never reads the database). Size M.

### 8. C19: hand-started GOAT servers get an update command that updates them (7eca0ed885 as "goat-launcher")

Changes: contracts ServerInstallation gains { kind: "goat-launcher", launcher, baseDir } (untrimmed non-empty paths). The server detects a runtime under `<home>/runtime/versions/<v>/goat` started through a launcher symlink whose home resolves to the same place, resolving the launcher before fixPath rewrites PATH (server.ts). Web: ServerUpdateAction offers the update command, `'<launcher>' update --base-dir '<home>' <version>`. versionSkew.ts quotes both paths, and --base-dir is checked against GOAT's CLI flag before the commit. resolveLauncherPath moves to pinnedRuntime.ts and skips directories and files without an exec bit. Older client, newer server: serverInstallation is ForwardCompatibleOptional (environment.ts:215), so the old schema decodes goat-launcher as absent and shows today's relaunch command (the decode test the ruling asks for, against the old union). Newer client, older server: the server never sends the kind; unchanged. Mobile: no update-command surface (rg serverInstallation in apps/mobile and client-runtime: none), so nothing to do. Negative: a runtime started directly (SSH launches, a copy), a link into another home, a path with a single quote, Windows (regex is POSIX: null). Docs: docs/user/updating.md table row. Rule 3: environment.test.ts's valid-kinds loop gains goat-launcher only if the line is the same as upstream's (IV); otherwise a new case. update.test.ts's import line and the launcher fixture's exec bit change as upstream (IV extension). Size S-M.

### 9. O25: AppImage updates keep their filename (e07585e5fb)

Changes: published Linux AppImages use version-free names, GOAT-${arch}.AppImage for stable and the nightly product's name for nightly (resolveDesktopProductName decides, checked in the commit); .deb and other targets keep versions. The release verifier's expected names and its asset classifier (release-verify.ts:500-501, :523, :537, :744) accept them; release notes, the marketing download patterns (the pattern for x86_64 AppImages, which ends in "x86_64" plus ".AppImage", still matches) and the workflow globs (release/*.AppImage) are checked. Desktop: an AppImage relaunched by electron-updater (APPIMAGE_SILENT_INSTALL) whose previous desktop entry named a versioned file in the same folder leaves a relative symlink from the old name to the new one, so launchers and the URL handler keep working (DesktopLinuxUrlHandler.ts, DesktopPreReadyPlatform.ts). Older installed client: a versioned GOAT-0.1.x-x86_64.AppImage updating to the first version-free release is installed beside under the new name and its old file deleted; the symlink covers it. That update itself is NOT RUN (needs a real release). Negative: entry in another folder, previous name without a version, current name with a version, not relaunched by the updater, symlink target already present (symlink never overwrites). Fail first: the pure verifier functions (new release-verify.appImage.test.ts) and replacedVersionedAppImagePath. Size S-M.

### 10. goat#3579: CJK preview fonts in every web copy (GOAT-own; measure, then one shared copy)

Prior art: VS Code Remote-SSH installs its server on each remote host and can download it on the client and copy it over ("remote.SSH.localServerDownload", https://code.visualstudio.com/docs/remote/faq), so a desktop install carries no per-remote server copies. Upstream T3 Code ships the same @betteroffice/fonts-cjk faces in its web client but does not bundle SSH runtime archives in its desktop installer (no sshRuntime in upstream main's scripts/build-desktop-artifact.ts), so it carries one or two copies where GOAT carries four or five. GOAT differs because its installer bundles three SSH runtime archives for offline installs (build-desktop-artifact.ts:244, :1728).
Step 1 (measure, no code): list the fonts-cjk files and bytes in one CLI archive and in one installer of nightly .376 (downloads to a temp folder, removed after), and attribute the .371 to .376 growth above. Step 2 waits on D4. Step 3: the release workflow's size report prints the font bytes; the 256 MiB archive cap check stays. Size M after D4.

## Rule 3 items expected beyond IV

- C20: serviceLauncher.test.ts:340 (already authorised by ruling C20). Possibly :297's code-78 case (sent with exact before/after if it changes).
- None else expected. Upstream's rewritten cases (d0d0608b6b's "commits only after the trial reports prepared", e805ce3712's deleted "waits for the launcher to durably commit the trial update ID", 26433ac070's renamed render test) stay as GOAT has them, and the new behaviour gets new cases. The mock and fixture lines f6b260df15 changes (`prepareTrial: Effect.undefined` to a function in selfUpdate.test.ts, serverRuntimeStartup.test.ts, serverRuntimeStartup.autoPull.test.ts) and selfUpdate.test.ts's harness lines fall under the IV extension only where GOAT's line equals upstream's. Any that does not is sent first.

## Order, size, gates

Order: move-outs as each row needs them, C17, C12-1, C12-2, C12-3, C12-4, C20, C12-5, C19, O25, goat#3579 (step 1 can run any time, step 2 after D4). About 14 commits.
Gate before each push: the touched test files run whole (serviceLauncher*.test.ts, cloud/bootService*.test.ts, selfUpdate*.test.ts, serviceLauncherClient.test.ts, servicePreflight.test.ts, serverRuntimeStartup*.test.ts, the persistence migration tests, cli/invocation.test.ts, cli/update.test.ts, pinnedRuntime.test.ts, environment.test.ts, versionSkew.test.ts, ServerUpdateAction.browser.test.tsx, DesktopLinuxUrlHandler.test.ts, DesktopPreReadyPlatform.test.ts, build-desktop-artifact*.test.ts, release-verify*.test.ts), then `vp run check:changed` against origin/chase/t3-261114-next3. Packages named as vp resolves them (apps/server is "goat"). One heavy job at a time on pen-mac-studio, after checking ps for another lane's vitest or check:changed, and none while a K5 or K10 fix round holds the token. No dev server, no turns: no row needs a provider.

## Decisions for the coordinator (one paragraph each)

D1, protocol-3 runtime under a protocol-4 launcher. Upstream's bump sends context protocol 4 and normalises durable state to 4. A protocol-3 runtime started by a protocol-4 launcher (probation rollback after a restart, above) rejects the context and never starts, and a protocol-3 launcher meeting state a protocol-4 writer left refuses to start. Options: (A) port as upstream and document the recovery (`goat service install` with the older CLI). (B) A GOAT deviation, recommended: keep the durable state and the child context at protocol 3, the format upstream itself calls unchanged ("Protocol 3 has the same IPC and durable format"). The launcher announces its capability in an extra optional context field (launcherProtocol: 4) that protocol-3 decoders ignore (serviceProtocol.ts:256-275 checks only named fields), and children send launcherProtocol ?? protocol to preflight. Cost of B: a fork-delta entry, and later upstream ports that touch the protocol field need adapting. I write the fail-first test either way.

D2, the backup side of C17. backupDatabaseOnce copies -wal beside the link (serviceLauncher.ts:264-268, the same upstream). A symlinked database with a live WAL after a crash is backed up without it, and the C17 restore then removes the real-side WAL, losing committed writes on rollback. Prior art: SQLite follows symbolic links unless SQLITE_OPEN_NOFOLLOW is set (https://www.sqlite.org/c3ref/open.html) and keeps the WAL beside the database file it opened (https://www.sqlite.org/wal.html); upstream's own comment in 034f3ba918 says the same. Proposal: one more commit in C17 that backs up -wal/-shm from beside the resolved file (a GOAT-own fix, test first). Yes or no.

D3, C20 at the bound. The ruling bounds the pending update at 10 minutes with db-owner-busy. I read it as: the update is then recorded failed and its backup discarded, and the launcher keeps probing every 30 s, without a bound, to start the active version when the home frees (upstream's behaviour for an idle launcher, no restart loop). Exit 79 (database-ahead) keeps failing at once. Confirm or amend.

D4, goat#3579 option after step 1. Recommended: the SSH runtime archives bundled in the desktop installer leave out the CJK faces, and when the desktop installs a runtime on an SSH host it copies the faces from its own web client (one copy per installer, roughly 3 x 34.8 MB less, offline still works). CLI release archives keep their faces because standalone installs need them offline. (b) fetching faces on first use is rejected for offline. This changes what the SSH runtime install sends (C4), so the exact path and its older-runtime case come to you as a plan after step 1.

D5, host and slot. The code starts when K5's review is through and pen-mac-studio's heavy-job token is free. The move-out claims above go into the card's table before any cut; please refuse overlaps (K7 claimed server and contracts files, none of mine).

D6, O25's identity. O25 = e07585e5fb by #3176's line order (above). Confirm.

## Risks

- C12-1 is large and touches the one process that keeps a user's service alive. A repoint bug can leave a unit naming a missing runtime, so the repoint stays best effort after a durable selection, and a unit naming a newer runtime or another home is left alone (upstream's guards, tested).
- The lease is a directory rename. On a filesystem where rename of a populated directory behaves differently (network home), acquisition fails after 30 s with a clear error and does not corrupt anything. Tested only on APFS.
- C20's poll keeps a launcher alive and idle where today it records failure. The 10-minute bound limits how long a pending update waits.
- O25 changes published file names. Anything outside the repository that links a versioned AppImage name breaks (none found in the repository beyond the verifier).

## NOT RUN expected

- A real systemd user unit or launchd agent install/update cycle: pen-mac-studio is shared and the service label (si.goat.service) is fixed, so a test install would replace the developer's real service; Linux systemd is also not on this host. Covered by fake managers and fake busctl.
- A real remote update between two released builds, and the L3 to L4 transition on a real host: needs a release containing this lane.
- O25's in-place AppImage update: needs a real release and a Linux desktop (owner's note on O25).
- Windows (93c10239b4 and f6b260df15's win32 branch held for the owner).
- goat#3579 installer builds per platform: measured from published nightly assets instead. A local mac build only if D4's option changes packaging.



## Coordinator rulings for this lane

> Coordinator to lane coordinator, 2026-11-17 23:58 UTC, relayed verbatim:
>
> VI. N10 PLAN: ACCEPTED with these rulings (records 688c83424d; I read the decisions section and the headings; claims as corrected on card 10.028 at 0dcef33f5f).
> D1: B. Durable state and the child context stay protocol 3; the launcher says what it can do in an optional launcherProtocol field. A machine that cannot start after a rollback is the worst outcome this lane can produce. Conditions: the fail-first case for the stranding (probation rollback after a restart under the new launcher); every launcher 3 or 4 with runtime 3 or 4 pairing as a case; and proof against the SHIPPED protocol-3 decoder (git show of a release tag's serviceProtocol.ts, not this head) that it ignores the extra field. Fork delta entry with the reason.
> D2: yes, one more commit: back up -wal and -shm from beside the resolved file, test first. It is committed writes lost on rollback. Note in the record that upstream has the same defect.
> D3: confirmed with one amendment: the backup is discarded at the bound only if the new runtime never opened the database; if it may have, the backup is kept and the normal rollback path runs. A case for each. The 30 s probe without a bound and exit 79 as you read them.
> D4: the direction is accepted for a PLAN only. goat#3579's code is not N10's: N10 records the measurement and sends the C4 plan (what the SSH install sends, the older-runtime case, a browser paired straight to the remote host, a failed copy falling back to system fonts), and it becomes its own lane after N10's READY.
> D5: yes: code after K5's review reports, one heavy job at a time on pen-mac-studio.
> D6: confirmed, O25 = e07585e5fb (I read #3176: its row is the unticked "AppImage updates keep their filename", a release decision). Conditions: a case showing what an INSTALLED versioned AppImage does with the new feed; the READY names the one-line revert; and "an installed versioned AppImage updates in place to the next release" stays an open release row that must be RUN on a nightly before that nightly's commit may go stable. I carry that row.
> Claim (3): IV (vi) covers a top-level it.layer block moved whole, on the same terms as a describe (byte-identical body, the case counts add up, TEST_TITLES updated in the same commit). Claims (4) and (5) need exact ranges on the card before the cut.
> Review weight: this lane is launcher, update and release in one. Its READY comes in two parts with a fresh C4 review each: N10-1 = move-outs, C17 with D2, C12 parts 1 to 5 and C20; N10-2 = C19 and O25. One branch, two READY reports, unless the whole delta ends under about 1,500 lines.
> f6b260df15's Windows part stays an open row on the card (not taken, no Windows run).
>
> Lane coordinator, for N10: quote it in next3-N10.md. Code waits for K5's review to report (I will tell you). Send claims (4) and (5) with exact ranges at the integration head before you cut them; claim (1) is on the card as :80-106 and :138-402.

> Coordinator to lane coordinator, 2026-11-17 23:50:37 UTC, relayed verbatim:
>
> II. Queue and one rule changed.
> - K7's wire review STARTED now (task goat-next3-K7-wire-review-9fb762a2), beside the conn review. Both read 9fb762a2b5; K7's head stays put until both report.
> - A fix-delta review (small: the delta and its test files only) does not count against the cap of two. So K5's fix-delta review starts as soon as its head and runs are there, and K10's likewise.
> - SF3 and N10 may start code now (K5's review has reported), heavy jobs by the machine token, K5's and K10's fix rounds first.
>
> Lane coordinator, for N10: CODE MAY START NOW, on the rulings of VI (relayed earlier). Before your first commit: git merge --ff-only origin/chase/t3-261114-next3 (still 259883c788) and report the sha. Heavy jobs by the machine token: K5's fix round first, then K10's, then you and SF3 one at a time. Claims (4) and (5) with exact ranges before you cut them.

Effects on the plan: D1 B replaces the upstream protocol-4 durable state and context; D3's discard condition changes C20; goat#3579 stops at the measurement and a C4 plan (no code in N10); READY in two parts (N10-1, N10-2).

ff-only merge before the first commit: `git merge --ff-only origin/chase/t3-261114-next3` reported "Already up to date"; HEAD stays 259883c788bb32d5601023932e07f879bde9af60.

## Claims (4) and (5), exact ranges at 259883c788

- (4) scripts/build-desktop-artifact.ts :1169-1253, InvalidMacPasskeyRpDomainReason..isMacPasskeySigningConfigurationError (85 lines: the Mac passkey error schemas and their union; they depend only on Schema) -> scripts/lib/mac-passkey-signing-errors.ts. build-desktop-artifact.ts imports the four classes it throws and re-exports the block's exports for build-desktop-artifact.test.ts and release-desktop-runtime.test.ts. This replaces the earlier "about :1236-1338": that range would have moved functions using the local DESKTOP_APP_ID (:114).
- (5) apps/server/src/server.ts :636-669, layerScheduledTaskWebhookOrigin (34 lines; it uses only imported names: ScheduledTaskWebhookOrigin, ServerSecretStore, isGoatConnectEnabled, RELAY_URL_SECRET, CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig, relayHookBaseUrl) -> apps/server/src/scheduledTasks/scheduledTaskWebhookOriginLayer.ts (GOAT-owned), imported back by server.ts.



> Coordinator, 2026-11-18 00:35:17 UTC (relayed by the lane coordinator 00:40 UTC), standing rule 3 extension beside IV, verbatim:
> "Standing rule from now, so this needs no round trip again: a type-only import added to an existing test file, and a layer provided to an existing case because the code under test gained a dependency, need no word from me when the commit changes no title, body, setup value or expectation of that case; the lane quotes the before and after in its record and the fresh review lists them. A provide that replaces or fakes a service the case's assertions read still comes to me."

> Lane coordinator, 00:20 UTC: the heavy-job token on pen-mac-studio passes K5 (until its fix head is pushed and its check:changed ends), then K10 (same), then SF3 and N10 one heavy job at a time, each after a ps check in its own step.

## Work log (code, local commits on the lane branch, nothing pushed)

| commit | row | fail first | after |
| --- | --- | --- | --- |
| 0d00aa1a33 | move-out (1) serviceLauncher.ts :80-106/:138-402 -> serviceLauncherDatabase.ts (exports added; restoreDatabaseBackup's 8-line doc comment rewrapped to 4 lines, goat/no-low-value-comments applies to the new file) | - | serviceLauncher*.test.ts + CloudLink.lifecycle.test.ts whole: 5 files, 71 passed; goat typecheck exit 0 |
| fa570fcc4d | C17 rollback half (034f3ba918) | serviceLauncher.linkedDatabase.test.ts:109 "expected true to be false" (trial WAL left beside the real file) | linkedDatabase + serviceLauncher.test.ts: 49 passed |
| 36854f1447 | D2 backup side (GOAT-own; upstream main's backupDatabaseOnce has the same defect, serviceLauncher.ts:552-556 at 7b4478895d) | "keeps writes the server left in the WAL beside the link's target": payloads lacked "served" | the five launcher files: 58 passed |
| 092d31afe5 | move-out (2) bootService.ts :388-487 -> bootServiceErrors.ts (BootServiceProblem gains export; export * re-export) | - | test run owed before push (token) |
| 538b8df027 | move-out (5) server.ts :636-669 -> scheduledTasks/scheduledTaskWebhookOriginLayer.ts | - | owed |
| 0c2e2907d0 | move-out (4) build-desktop-artifact.ts :1169-1253 -> scripts/lib/mac-passkey-signing-errors.ts | - | owed |

Written, not yet committed (waiting for the token to run their fail-first and whole files): C12-1 (serviceSelectionLock.ts from upstream with one line changed to drop a non-null assertion; serviceUnitRepoint.ts; launcher #selectState and unit repoint; installer leases and recovery command; D1 B in serviceProtocol.ts; fork-delta block service-launcher-protocol; docs), C12-5 (migrationPreflight.ts, plannedGoatLedger extracted from moveGoatLedger without behaviour change, upstream reconcileV2PreviewMigration.ts), C19, O25.

e805ce3712 under D1 B: the context and durable state stay protocol 3, so a new runtime runs under a protocol-3 launcher with no acceptance change, and the preflight keeps receiving --launcher-protocol 3 from every child. The port reduces to the launcherProtocol field; no preflight or selfUpdate change is needed. Recorded here so the review reads it as a decision, not an omission.

D1 proof against the shipped decoder (transcript): git show v0.1.10:apps/server/src/cloud/serviceProtocol.ts (tag commit 6f872e6b2d, sha256 ca21c52b7b851df31652d95a150e60f23cccd1b224f7a58264cb46e21387fce1), run with node --experimental-strip-types:
```
context with launcherProtocol:4 -> {"protocol":3,"childVersion":"1.0.0","update":{"id":"u1","fromVersion":"1.0.0","targetVersion":"1.1.0","status":"rolled-back","reason":"probation-exit:1"}}
context with protocol:4 (upstream) -> undefined
state protocol:3 -> {"protocol":3,"activeVersion":"1.0.0"}
state protocol:4 (upstream) -> undefined
```

O25, what an installed versioned AppImage does with the new feed: electron-updater 6.8.9 AppImageUpdater.doInstall (node_modules/.pnpm/electron-updater@6.8.9_supports-color@8.1.1/node_modules/electron-updater/out/AppImageUpdater.js:81-112) unlinks the running AppImage; because its name has an x.y.z version and the feed's does not, it moves the update to dirname/<feed name> and relaunches it with APPIMAGE_SILENT_INSTALL=true. The relaunched build leaves a relative symlink from the old name (DesktopPreReadyPlatform.appImage.test.ts). Later updates replace the version-free file in place. The one-line revert of O25: delete the buildConfig.appImage block in createBuildConfig (the verifier change goes with it).

## goat#3579 measurement (D4: N10 records it and sends the C4 plan; the code is its own lane after N10's READY)

`gh release download v0.1.10-nightly.20261117.376 -p goat-0.1.10-nightly.20261117.376-linux-x64.tar.gz` then `tar -tvzf`: the archive holds the five faces under client/assets, 34,818,280 bytes (NotoSansJP 4,533,028; KR 4,644,748; SC 8,331,336; TC 5,683,368; NotoSerifSC 11,625,800), of 560,234,570 uncompressed bytes. OTF does not compress, so the archive grew by 33.2 MB (.371 168,871,544 -> .376 202,056,726). Installers carry the web client four times (five on Windows): +133.9 MB AppImage, +134.6 MB dmg, +163.5 MB exe, which matches 4 x and 4.7 x the faces. The C4 plan (what the SSH install sends, an older runtime, a browser paired straight to the remote host, a failed copy falling back to system fonts) follows with N10's READY. One constraint found already: bundled SSH archives are verified by a SHA-256 sidecar and remote installs record the release digest (packages/ssh/src/runtimeArchive.ts:46-60; docs/internals/server-updates.md "install-record"), so a trimmed archive cannot reuse the release archive's identity.



## Rulings relayed after 00:40 UTC (verbatim where quoted)

> Coordinator 00:45:31 UTC: "From now on for every lane: READY means the gate exited 0 on the pushed head, or the report names each failure with the same failure shown at the integration head."

> Coordinator 01:14:39 UTC, IV: "STANDING RULE, every lane, from now: before READY, every apps/server test file the lane added or changed is run once from apps/server with GOAT_TEST_TMP_GUARD=fail (CI sets it, check:changed does not), and the READY report says so. The ps check in its own step first, as before."

> Coordinator 01:17:54 UTC, II: "RULE 3, standing rule extended (beside the 00:35:17 rule), every lane: a VALUE import added to an existing import line of an existing test file needs no word from me when only appended cases or appended helpers use the new names and no existing title, body, setup value or expectation changes. The lane quotes the line before and after in its record; the fresh review lists it. An import that changes what an existing case runs against (a different module, a fake in place of a real service) still comes to me." V: "No git stash in any lane" stands; a lane that needs to set work aside commits it on its own branch locally.

> Coordinator 01:20:03 UTC: "RULE 3, the 01:17 rule II covers a NEW import statement on the same terms as a name added to an existing line: only appended cases or appended helpers use what it imports, it imports a real module (no fake, no mock, no replacement of something an existing case reads), the import has no effect at load time that an existing case could see (no vi.mock beside it, no module that registers or patches something when loaded), and no existing title, body, setup value or expectation changes."

> Coordinator 02:06 UTC, III: in zsh, a push refspec written as dollar-C-colon applies the :r modifier; write the variable in braces in every push and REV:path. (N10 already does.)

> Lane coordinator 01:57 and 01:58:30 UTC: SF3 and N10 alternate one heavy job each after K10's nits round; a long run is announced in the record first.

Time note: the lane coordinator's stash-incident message carried "about 02:00 UTC"; its real send time (between 00:55 and 01:16 UTC) is in the thread log. N10's report of it repeated that time.


## Stash incident (closed by the coordinator)

At N10's C12-1 fail-first, git stash pop -q applied SF3's "sf3-3b-failfirst" entry (CursorAgentSdk.ts), because worktrees share one refs/stash. N10's own entry was then popped by name (dropped stash 75693f1d9f), and serviceLauncher.ts was byte-identical to the saved copy. SF3's diff was saved to /tmp/n10-sf3-CursorAgentSdk-found-in-n10.patch and checked out of N10's tree. No N10 commit contains it. N10 uses no git stash; fail-first runs set code aside as patch files.

## Rule 3 items in N10 so far (before and after)

- serviceLauncher.test.ts:339 (authorised by ruling C20 for :340): before "it.effect.each(refusalCases)("; after "it.effect.each(refusalCases.filter(({ reason }) => reason === "database-ahead"))(". The state-dir-owned case of that test now has its new expectations in serviceLauncher.ownerPoll.test.ts: pending while owned, a trial once free, db-owner-busy at the bound in both D3 branches. Title, body and the database-ahead expectations are unchanged. The file's length stays 1568, its entry.
- cli/update.test.ts:157 (IV extension, the fixture line upstream 7eca0ed885 changes the same way): before 'yield* fs.writeFileString(launcher, "");'; after 'yield* fs.writeFileString(launcher, "", { mode: 0o755 });'. resolveLauncherPath now skips files without an exec bit, as upstream's does. Its import stays on ./update.ts, which re-exports it.
- packages/contracts/src/environment.test.ts: a new statement 'import { ForwardCompatibleOptional, TrimmedNonEmptyString } from "./baseSchemas.ts";', used only by the appended case (rule of 01:20:03).
- apps/web/src/versionSkew.test.ts, apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts, apps/server/src/cli/invocation.test.ts: appended cases only, no import change.
- Possible later item, not changed: the refusal message for exit 78 ("Stop it, then restart this service.") stays as it is. Upstream changed it to "This service starts again once it stops.", but serviceLauncher.test.ts:297 asserts the exact line through refusalCases, so changing it goes to the coordinator first.

## C20 notes

- The pending update keeps its backup while it waits. GOAT's restore already refuses to restore over another server's writes (owner-generation check), so the backup stays safe to keep.
- "May the new runtime have opened the database" (D3): the launcher writes .trial-started into the backup directory right before it spawns a trial. It cannot read the owner log while another server holds that lock.
- #startTrial's own busy lock (the existing immediate db-owner-busy, test :857-890) is unchanged; changing it would move an existing expectation.
- The probe is the launcher's own Node-only copy of acquireServerOwnership's checks (serviceLauncherOwner.ts). serverOwnership's exclusive open now waits 250 ms (busy_timeout), so a server starting during a probe is not refused (upstream 44ee2b9c34 does the same).
- Timing in tests: the launcher has no Effect runtime, so its clock is injected (now) and its probe interval is an option. The tests await file events and launcher log lines, with no sleeps.

## goat#3579 C4 plan draft (sent with N10's READY; its code is its own lane, ruling D4)

Today: the desktop installer bundles three SSH runtime archives, each a full release archive with client/assets and the five faces (34,818,280 bytes). runtimeProvisioning tries the host's own download first, then the bundle, then the user cache, then HTTPS/gh (packages/ssh/src/runtimeProvisioning.ts:457-530). A bundled archive is checked against its SHA-256 sidecar (runtimeArchive.ts:46-60).
Proposal: the bundled archives leave the five faces out (a build step, with their own sidecar), and the installer ships the faces once, beside its own web client. When a bundled archive is used, the desktop app sends the faces as a second, small archive and unpacks it into <versionDir>/client/assets before writing .install-complete.
- What the SSH install sends: the trimmed runtime archive plus one fonts archive, both checked against sidecars. The host-download and HTTPS paths are unchanged and keep full archives.
- Older runtime: an older bundled version is not bundled by a newer app, so the only mixed case is a host that already holds a full runtime of the same version. It is reused as it is (install record and executable SHA match).
- A browser paired straight to the remote host: it is served that host's client/assets. If the faces were sent, previews are as today. If not, loadFace's request fails.
- A failed copy: the install still completes, and the CJK preview falls back to the last-resort face instead of failing. That needs a web change in apps/web/src/components/files/office/fonts.ts (a rejected face load returns the fallback face), with a browser test.
- Release: the 256 MiB cap check stays, and the release workflow's size report adds the font bytes.
- Install record: a trimmed archive records its own digest. A later release-digest check on the host re-installs from the full release archive, which degrades to today's behaviour.

