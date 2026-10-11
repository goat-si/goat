# Lane L3_updater (gpt-6.1-sol, read-only, 2026-10-12, base 32f7bda9b)

**Desktop update flow**

- `packages/contracts/src/ipc.ts:71`: states are `"disabled"`, `"idle"`, `"checking"`, `"up-to-date"`, `"available"`, `"downloading"`, `"downloaded"`, `"error"`. There is no installing state; installation holds a separate action reservation.
- `apps/desktop/src/updates/DesktopUpdates.ts:248`: updates require a configured feed and packaged production build; disabled by `T3CODE_DISABLE_AUTO_UPDATE`. Linux requires AppImage or `.deb`.
- `apps/desktop/src/updates/DesktopUpdates.ts:933`: `"setAutoDownload(false)"`; line 934: `"setAutoInstallOnAppQuit(false)"`. Current automatic behavior only checks.
- `apps/desktop/src/updates/DesktopUpdates.ts:50`: startup delay `"15 seconds"`, polling interval `"4 minutes"`. Scoped fibers implement both at lines 705 and 720. Checks skip quitting, unconfigured, downloading, or another reserved action (`:414`, `:426`).
- `apps/desktop/src/updates/DesktopUpdates.ts:369`: check/download/install/channel changes share one reservation; channel changes fail while another action is active.

Reducer transitions in `apps/desktop/src/updates/updateMachine.ts`:

| Trigger                  | Result and proof                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| Configure                | Enabled → idle; otherwise disabled (`DesktopUpdates.ts:214`)      |
| Check starts             | checking; preserves downloaded payload (`updateMachine.ts:43`)    |
| Check fails              | error/check; preserves an existing download as downloaded (`:61`) |
| Update available         | available, or downloaded if already cached same version (`:89`)   |
| No update                | up-to-date; existing download remains downloaded (`:113`)         |
| Download starts/progress | downloading (`:145`, `:172`)                                      |
| Download fails           | available when retryable, otherwise error (`:8`, `:158`)          |
| Download completes       | downloaded, 100% (`:186`)                                         |
| Install fails            | downloaded with install error and retry (`:202`)                  |

Channel handling already supports the requested version format:

- `apps/desktop/src/updates/updateChannels.ts:3`: nightly regex `"-nightly\\.\\d{8}\\.\\d+"`; `:16` defaults matching versions to nightly, otherwise latest.
- `apps/desktop/src/updates/DesktopUpdates.ts:394`: nightly enables prereleases, downgrades, and full changelog.
- `:744`: ignores available updates whose inferred channel differs from selection.
- `:989`: persists selection, resets state, applies channel, then temporarily enables downgrade for the channel-change check (`:1005`), restoring the normal policy afterward.

Download/install:

- `apps/desktop/src/updates/DesktopUpdates.ts:461`: downloads only from available state; reserves action, sets downloading, disables differential download for Intel builds on ARM hosts, calls `downloadUpdate`.
- `:581`: installation requires configured updater and matching downloaded version. Accepts downloaded or eligible install-error state. Prepared installs can wait up to 90 seconds for a competing check; manual installs refuse that contention (`:602`, `:618`).
- `:629`: sets quitting, writes restart marker, stops **every pooled backend concurrently**, each with five-second timeout (`:640`).
- `:646`: calls `"quitAndInstall"` with `"isSilent: true"` and `"isForceRunAfter: true"`.
- `:551`: failure clears quitting/marker, restarts every pooled backend, returns downloaded retry state. Successful relaunch is owned by Electron/updater.
- `apps/desktop/src/app/DesktopLifecycle.ts:206`: `"updaterQuitAllowed = true"` prevents ordinary shutdown interception from breaking native quit/install/relaunch; destroys windows synchronously.
- `apps/server/src/cloud/updateHandoff.ts:64`: consumes the desktop restart marker; marker TTL is one minute (`:21`). Its purpose is preserving the managed tunnel across restart (`DesktopUpdates.ts:519`).
- Additional install entry: `apps/desktop/src/updates/DesktopRemoteUpdates.ts:425` calls `installPrepared`.

**Settings, bridge, UI, and tests**

`apps/desktop/src/settings/DesktopAppSettings.ts` owns desktop preferences:

- Typed settings `:35`; defaults `:77`; optional persisted schema `:99`.
- Normalize older/missing values `:215`; sparse serialization `:253`.
- `:498`: `"SynchronizedRef.modifyEffect"` persists before replacing memory; no-op updates avoid writes.
- `:462`, `:472`: temporary-file write then rename.
- `apps/desktop/src/app/DesktopEnvironment.ts:216`: file is `"desktop-settings.json"` under desktop state directory.

For `pauseAutomaticUpdateRestart`, add boolean to interface/default/schema/normalization/sparse serializer; semantic setter and service method; production implementation and `layerTest` (`DesktopAppSettings.ts:174`, `:345`, `:561`, `:619`).

Expose through existing update bridge:

- `packages/contracts/src/ipc.ts:270`, `:301`: state interface/schema.
- `:1236`: `getUpdateState`, `setUpdateChannel`, check/download/install, state listener.
- `apps/desktop/src/ipc/channels.ts:22`: update channel constants.
- `apps/desktop/src/ipc/methods/updates.ts:24`: schema-decoded thin service handler.
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts:155`: registration.
- `apps/desktop/src/preload.ts:266`: renderer bridge implementation.

UI: `apps/web/src/components/settings/SettingsPanels.tsx:293` changes channel; `:329` downloads; `:342` confirms installation; `:430` renders version/action row; `:452` renders stable/nightly selector. Add pause control here and expose its value through update state. Sidebar is another entry point (`apps/web/src/components/sidebar/SidebarUpdatePill.tsx:152`).

Tests:

- `apps/desktop/src/updates/DesktopUpdates.test.ts:1`: `@effect/vitest`; scoped Effects, `TestClock` (`:63`), Deferred-controlled contention (`:322`).
- `apps/desktop/src/updates/updatesTestHarness.ts:18`: `"events are driven by hand via emit"`; injected updater/backend Effects and recorded actions.
- `updateMachine.test.ts:22`: pure reducer assertions using `vite-plus/test`.
- Also present: `updateChannels.test.ts`, `releaseNotes.test.ts`, `DesktopRemoteUpdates.test.ts`, `remoteUpdateFlow.test.ts`, and `apps/desktop/src/electron/ElectronUpdater.test.ts`.
- `DesktopAppSettings.test.ts:142`, `:189`, `:210`, `:338`: persistence, failed writes, no-ops, sparse documents.

**Smallest backend activity signal**

Reuse `GET /.well-known/t3/activity`:

- `packages/contracts/src/environmentHttp.ts:462`: existing typed endpoint.
- `apps/server/src/http.ts:329`: rejects non-loopback peers; `:334` calls `getServerActivity`; response includes activity, version, PID.
- `apps/server/src/orchestration-v2/ProjectionStore.ts:5951`: SQL existence queries cover runnable queued/preparing/starting/running/waiting runs; pending/running/waiting nodes, subagents, command/tool items; provider turns; pending background work and runtime requests. Excludes rolled-back and unstarted held-queue work.
- Existing coverage: `ProjectionStore.test.ts:5003`, `:5235`; endpoint tests `http.test.ts:766`.
- Desktop lifecycle has no agent-work quit guard (`DesktopLifecycle.ts:97`). Backend snapshots expose process readiness, not work activity (`DesktopBackendManager.ts:246`).

Recommendation: query each backend the installer will stop, validate PID/version where available, and postpone automatic restart on busy or unknown. Instance configuration is accessible through `DesktopBackendManager.ts:274`.

**Release repository changes**

Concrete changes:

| File:line                                         | Change                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/cliRelease.ts:8`             | Set `CLI_RELEASE_REPOSITORY` to `goat-si/goat-releases`; feeds shared archive URLs (`:57`) and web release notes (`desktopUpdate.logic.ts:6`).  |
| `scripts/build-desktop-artifact.ts:65`            | Change desktop repository constant. `:2766` explicitly rejects any other repository; nightly publish already uses prerelease/channel (`:2775`). |
| `scripts/install.sh:20`                           | Change repo. API discovery `:157` and archive base `:21` derive from it.                                                                        |
| `scripts/install.ps1:19`                          | Change repo. Discovery `:142` and archive base `:20` derive from it.                                                                            |
| `apps/marketing/src/lib/releases.ts:1`            | Change repo; stable/latest and nightly list URLs derive from it (`:6`, `:10`).                                                                  |
| `apps/marketing/src/pages/index.astro:65`, `:408` | Replace upstream release fallback links.                                                                                                        |
| `scripts/build-npm-platform-packages.ts:213`      | Replace release/archive help URL.                                                                                                               |
| `packages/ssh/src/tunnel.ts:1862`                 | Update hardcoded release-repository diagnostic.                                                                                                 |

SSH fixtures `packages/ssh/src/fixtures/remote-runner-baseline.json:3` contain generated old archive URLs; update expectations when changing shared constant. Web URL expectations also exist in `desktopUpdate.toast.test.tsx:76` and `sidebar/SidebarUpdateReleaseNotes.test.tsx:90`.

Installers currently default **stable** (`install.sh:145`, `install.ps1:130`); nightly requires `T3CODE_CHANNEL=nightly`. Decide whether nightly-only distribution changes that default.

`apps/marketing/src/lib/site.ts:1` is a **source repository** link, not release consumer. Parent should decide its destination separately; upstream attribution/source references should not undergo blanket replacement.

**License packaging and uncertainties**

- `LICENSE:3`: `"Copyright (c) 2026 T3 Tools Inc."`; preserve required notice (`:12`).
- `scripts/sync-third-party-license-notices.ts:9` calls sync; implementation `scripts/lib/third-party-licenses.ts:412` caches SPDX texts. It does **not** generate a standalone `THIRD_PARTY_NOTICES`.
- Web plugin emits `"third-party-licenses.json"` (`third-party-licenses.ts:1007`, `:1016`); includes web/server/desktop manifests (`apps/web/vite.config.ts:164`).
- CLI copies web client (`build-cli-archive.ts:510`); desktop stages server dist (`build-desktop-artifact.ts:4064`), so web JSON travels with both.
- No explicit root LICENSE or standalone notices staging in CLI (`build-cli-archive.ts:509`). Desktop explicitly installs LICENSE only for `.deb` (`build-desktop-artifact.ts:3017`).
- Recommend explicit LICENSE and complete standalone notice staging for both builders. Existing `apps/mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md:5` is mobile-specific.

Unresolved: activity checks race newly admitted work; strict interruption prevention requires backend admission coordination. WSL requests may hit the loopback restriction (`DesktopBackendConfiguration.ts:746`); verify transport before reuse. Artifact contents were not built or inspected. Adjacent finding: CLI notarization currently requires API keys (`build-cli-archive.ts:338`); change to `--keychain-profile goat-notary` (`:355`) for the specified credentials.

Read-only discovery only; no files changed or tests run.
