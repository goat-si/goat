Stale check @cd1dfd752 — amended-hunk count: **0** (no stale before-images). All **385** hunks in **85** diff blocks rechecked against this HEAD and preceding-stage after-images; all recorded source hashes still match. One verification recipe amended: web selects `--project unit`. Execution verifiers **NOT RUN**.

# 030 — wp4: GOAT executable, archive contract and remote home isolation (D8 + D7-A)

## Loop spec

- Archetype: satisfy-spec; one parent-owned P→A→B→C→D work-phase. This leaf writes the plan only and owns no FSM, loop, goal, branch, or child dispatch.
- Trigger: D8 in `000_plan.md`: users need a `goat` CLI and SSH/WSL/service consumers need GOAT executable/archive bytes.
- Goal: build `goat`/`goat.exe`, package `goat-<version>-<platformKey>.tar.gz` (Windows `.zip`), consume the same names everywhere, expose npm bins `goat` and `t3` from package `t3`, show `goat` in standalone/help/desktop guidance, and isolate remote runtime/state/server home under `~/.goat` through mandatory D7-A.
- Non-goals: npm or GitHub publication, package/scope rename, provider/MCP key rename (wp3/wp6), service-id/protocol/env-var/global-home migration, changing mobile store ids, live service restart, browser/computer-use, upstream shim removal, or tests/builds/install execution by this leaf. D7 is decided: apply D7-A inside wp4; D7-B is discarded and not executable. Remote isolation does not migrate upstream data.
- Verifier: parent runs only named focused tests/typechecks below, inspects archive/signing/CI filename flow and stale-name gates, then independent review. Real SSH belongs to wp5. All test/typecheck/build verifiers here are **NOT RUN**: delegation explicitly forbids execution. Read-only `rg`/`sed`/config reads ground paths and test selection; no exit-code pass is invented.
- Stop: this leaf returns this complete diff-level document. Parent stops wp4 after focused gates and independent review; Completion of mandatory D7-A with isolation proof is required before wp5 server launch.
- Memory artifact: this file in `devlog/_fin/261011_goat-release-rename/`, with parent's evidence directory. Do not commit plan or PR-only evidence.
- Outcomes: PLAN_WRITTEN for this leaf; parent DONE for D8 + D7-A with evidence; NEEDS_HUMAN for unexpected state/service ownership conflicts; BLOCKED for missing toolchain or incompatible earlier-phase signatures.
- Escalation: apply the recorded runtime namespace decision; stop before touching an upstream home, rewriting a live runner, installing a shared service id, publishing, or broadening to other branding/identity work. No child grant was consumed.

## Binding decisions and implementation order

Source root for **all patch paths**: `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename`.
Baseline is the read-only source at **cd1dfd752d1486948f461eac1ebfb9c16f6cb416**, re-inspected on 2026-10-11. wp2 (`fe8df0d3a`) already changed release acquisition and the retained-runner probe; wp3 (`f08a410af`) already changed MCP tools/server branding and legacy context handoff. **050 (provider-key wp6) is now landed at cd1dfd752**, changing `t3-code` to `goat` across provider adapters, instructions, docs and fixtures. All recorded file-map hashes still match this HEAD. Retain its `goat` namespace and make no provider adapter edits in 030. Core hunks use current before-images; A11 uses core after-images; D7-A uses core + A11 after-images. Preserve wp2's `goat-si/goat` repository, authenticated local gh acquisition, retained-runner branch ordering and ghCommand override. Parent must refresh any overlap introduced after this inspected HEAD.

1. Apply the recorded collision amendment to D8: use `<baseDir>/runtime/goat/versions/<version>` for GOAT pinned runtimes. The core SSH hunks are an intermediate composition stage; mandatory D7-A changes the final remote home to `.goat` while retaining the same `runtime/goat/versions` suffix. User chose `~/.goat` on 2026-10-11 (000 D7 and 002 final disposition). Do not execute or ship the intermediate core-only remote `.t3` paths. It is necessary locally as well: install scripts, serviceLauncher and pinnedRuntime otherwise remove an upstream directory at the same exact version. Never migrate/copy/remove the old `<baseDir>/runtime/versions` tree. A namespace is preferable to rejecting an upstream cache forever, and keeps .install-complete's version-only format intact.
2. Producer/shared naming: SEA output, shared archive resolver, archive builder, npm manifests and both launchers. Keep `bin/t3.js`, `dist/bin.mjs`, `t3.tgz`, @t3code platform-package names and workspace filters.
3. Runtime consumers: pinnedRuntime and standalone serviceLauncher in lockstep, SSH runner/probe/upload, install scripts, WSL verification and backend entry, desktop artifact preflight, smoke consumer, release workflow checksum glob and WSL input glob.
4. Desktop: write `bin/goat` or `goat.cmd`, use a unique GOAT marker and GOAT Windows PATH receipt. Install/remove only GOAT-owned goat links; leave all t3 links/files and upstream markers alone. No automatic legacy shim cleanup.
5. CLI/help and client guidance: CLI root is goat, errors/help/standalone suggestions are goat; `npx t3`, `pnpm dlx t3`, `bunx t3`, npm install/uninstall package arguments stay. npm ownership detection accepts old t3-only manifests and new dual-bin manifests.
6. Existing fixture updates + focused behavioral regression additions. Review frozen SSH fixture as lifecycle-significant bytes, not cosmetic output. The preparation/upload transient runner must still leave an existing managed runner byte-for-byte unchanged; keepExistingRunner remains enabled.
7. Apply **mandatory D7-A inside wp4** after composing core + A11 + wp2/wp3/wp6. D7-B is discarded and not executable; D7-A patches all remote state/home locations together, including pairing/session issuance/stop/log. Never rename run-t3.sh or run-t3.next: cmp/keepExistingRunner and persisted coordination depend on those names.
8. Execute the focused commands and gates, record every exit/outcome; do not substitute local full-suite tests, run CI or launch browsers in this leaf. Parent owns independent review and wp5 authorization.

## Scope and cross-surface accounting

- Web and desktop Settings both expose the same install/remove service through the existing bridge; only labels/search text and the shared desktop backend entry change. No new RPC/schema/permissions or handler IO. CLI server methods retain existing Effect services and scoped process/filesystem dependencies. Standalone serviceLauncher remains its existing Node-only exception.
- Mobile receives only the pairing command hint; shared client-runtime retains the valid `sudo npx t3 browser setup` npm fallback. wp6 has already cut provider MCP registrations over to `goat` before wp4; retain that final namespace while changing executable paths. Entry paths handed to provider subprocesses originate from the changed archive/WSL/backend pipeline.
- Local/SSH/WSL paths are covered. T3 Connect protocol/relay/service ids/AppArmor profile ids, T3CODE_* env vars, local `.t3` default and WSL marker names are preserved. WSL runtime ids are already SHA-256 identities, so renaming archive bytes selects a distinct runtime; no WSL state-dir migration is needed here.
- Release acquisition/auth belongs to wp2. Anonymous installers/update consumers remain subject to D4's private-repository limitation. This plan does not claim public `npx t3` will download GOAT before authorized publishing; current public package ownership stays a separate release concern.
- Source-of-truth sync: update existing user install/background-service/remote-access/welcome/updating guidance and the archive paragraph of existing operations/release.md. No internal file catalog or new architecture page is warranted.
- Production file changes below are MODIFY only; the Windows behavioral test is NEW; no DELETE. No data/schema/enum migration. Tests added inside existing suites exercise actual IO/spawn/ownership behavior, rather than callback wiring/static-render mirrors.

## Unchanged indirect consumers (NO CHANGE)

| Exact absolute path                                                                                                                 | Reason no diff is required                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchive.ts`                         | readLocalRuntimeArchive calls cliArchiveFileName; helper selects goat archives. Actual filesystem tests change below.  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/main.ts`                                   | supplies version/archiveDirectory/releaseBaseUrl, no executable basename/remote home; tunnel builders own those paths. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/client-runtime/src/preview/serverBrowserStream.ts` | sudo npx t3 browser setup names the unchanged npm package.                                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/marketing/src/lib/releases.ts`                         | wp2 owns repository; no CLI asset basename selected here.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packaging/aur/t3code-bin/PKGBUILD`                          | desktop AppImage consumer; wp2 owns URLs, D8 excludes app ids.                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packaging/aur/t3code-nightly-bin/PKGBUILD`                  | same desktop-only boundary.                                                                                            |

## Review and application instructions

Core unified hunks contain literal cd1dfd752 before-lines, proposed after-lines and context; staged A11/D7-A hunks contain literal preceding-stage after-lines. The table identifies exact absolute paths and action. To execute, parent copies the diff blocks into an external temporary patch and applies them in the authorized source tree, after rechecking any source changes since cd1dfd752; preceding 050 changes are already included in this stale check. Do not copy Markdown prose into a patch. Mandatory D7-A hunks are relative to the **core + A11 after-state**; core-only remote `.t3` paths are not a runnable final implementation. No hunk is applied by this leaf.

The authorizing packet grants this single plan-file write despite AGENTS' default of scratch outside the tree; it grants no source write/test/build/server/git mutation. Parent owns consultation/reflection in 002_architect.md and independent A audit. This document makes no claim that those steps passed.

## Core file map

| Exact absolute source path                                                                                                                 | Action | Inspected SHA-256 (first 16) | Purpose                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/vite.config.ts`                                        | MODIFY | `bbe145c419b7d727`           | SEA output name (including tsdown target suffixes).                                                                                                                                                        |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/package.json`                                          | MODIFY | `efc8e633047405bd`           | Keep npm/workspace name t3; expose both command names from source package.                                                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.ts`                                 | MODIFY | `9433d8a2153d0ee2`           | Shared archive filename; release repository is owned by wp2.                                                                                                                                               |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-cli-archive.ts`                                      | MODIFY | `b5caa993c5124e4c`           | Archive stem, SEA input, packaged entry, signing/help diagnostics; runtime npm manifest and native resource-monitor names stay unchanged.                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.ts`                            | MODIFY | `3c5d08709ae8bf70`           | All npm package identities/filenames stay t3 and @t3code/t3-*; both bins invoke bin/t3.js, which executes goat/goat.exe.                                                                                   |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/legacyCliLauncher.ts`                          | MODIFY | `b82b1c4f822f1a34`           | Legacy dist/bin.mjs forwards IPC/signals to renamed executable; keep npm package path.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/pinnedRuntime.ts`                            | MODIFY | `8d7f4d8e16a0ec13`           | Own runtime/goat/versions namespace protects an upstream runtime at the same home/version; marker remains .install-complete.                                                                               |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/serviceLauncher.ts`                                | MODIFY | `f334eb8b4d1b0742`           | Standalone Node-only launcher must mirror pinnedRuntimePaths; retain boot-service ids/protocol.                                                                                                            |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts`                                        | MODIFY | `4406d465264b211c`           | Rename archive/entry in runner, upload installer and probe together; runtime namespace protects same-version upstream cache. Remote state/server home move to `~/.goat` through mandatory D7-A inside wp4. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.sh`                                                | MODIFY | `dc77a9736006d1bb`           | Own goat shim and runtime namespace; marker alone is insufficient. Keep T3CODE_HOME default and npm fallback package identity.                                                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.ps1`                                               | MODIFY | `85fc04da5d7a34dd`           | Own goat shim and runtime namespace; marker alone is insufficient. Keep T3CODE_HOME default and npm fallback package identity.                                                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliShim.ts`                            | MODIFY | `932dca4808d46372`           | Unique GOAT ownership marker. Never accept legacy upstream marker or touch bin/t3; retain T3CODE_CLI_PATH/T3CODE_HOME.                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliCommand.ts`                         | MODIFY | `8fd807744aba38a4`           | Install/remove only goat links with GOAT marker; namespace Windows PATH ownership receipt so old upstream receipt cannot authorize removal.                                                                |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/wsl/DesktopWslEnvironment.ts`                     | MODIFY | `a2514b97723a1c61`           | WSL executable checks, digest, preflight and backend invocation all use goat; archive hash identities/WSL marker names remain.                                                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/backend/DesktopBackendConfiguration.ts`           | MODIFY | `606d52f838904d45`           | WSL executable checks, digest, preflight and backend invocation all use goat; archive hash identities/WSL marker names remain.                                                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-desktop-artifact.ts`                                 | MODIFY | `06e62f413b92c86f`           | WSL archive stem/member preflight; leave Electron/native helper ids intact.                                                                                                                                |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/smoke-cli-archive.ts`                                      | MODIFY | `98b69611bf8fdb4a`           | Real archive smoke launches goat; do not execute it in this leaf.                                                                                                                                          |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/release.yml`                                     | MODIFY | `30292496ee748321`           | Checksums/upload find renamed archives; npm filters/publication unchanged and not authorized to run.                                                                                                       |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/release-desktop.yml`                             | MODIFY | `0460811d0ecbd2d7`           | Desktop job locates renamed Linux archive.                                                                                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/scripts/cli.ts`                                        | MODIFY | `d4e247bbbd9f1340`           | Build success help points at actual artifact; publishing t3 tarballs remains unchanged.                                                                                                                    |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/invocation.ts`                                 | MODIFY | `264e9622f20226f4`           | Prefer proven goat global bin for new manifests; legacy t3-only manifests/native entries still classify, npm runner suggestions remain npx/pnpm/bunx t3.                                                   |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/binCli.ts`                                         | MODIFY | `42a7596b283e41a5`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/service.ts`                                    | MODIFY | `b1cd37fca9735728`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/pair.ts`                                       | MODIFY | `30c199726d5020a8`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/connect.ts`                                    | MODIFY | `0a6a629626f9ed86`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/app.ts`                                        | MODIFY | `f69f835b5535a4f1`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/triage.ts`                                     | MODIFY | `f95bb60b42f5cacc`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/triagePrompt.ts`                               | MODIFY | `970eb9747c0e38e4`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/uninstall.ts`                                  | MODIFY | `13f9cebb1c7bc572`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/browser.ts`                                    | MODIFY | `49e7ef6f1c143338`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/trace.ts`                                      | MODIFY | `f2699761f74a3316`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/config.ts`                                     | MODIFY | `8ecb75f017250db7`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/bin.ts`                                            | MODIFY | `f6ffd03fadd4be5e`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/update.ts`                                     | MODIFY | `4c7f93c76d41b3fc`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/CloudLink.ts`                                | MODIFY | `08de42c516a15d14`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/relayResponse.ts`                            | MODIFY | `6b5e6688f7e30efc`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/selfUpdate.ts`                               | MODIFY | `d74f3e7810257734`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/bootService.ts`                              | MODIFY | `55eb86272d6c58d3`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/preview/PreviewBrowserHost.ts`                     | MODIFY | `47675238e2fd6703`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/HostProcess.ts`                                | MODIFY | `db6f13db034a5163`           | CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/settings/CliCommandSettingsRow.tsx`        | MODIFY | `73e366b69af731d7`           | User command guidance/search on web/desktop/mobile; no wire-contract or layout change.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/settings/settingsSearch.ts`                | MODIFY | `eed0f5dcec290947`           | User command guidance/search on web/desktop/mobile; no wire-contract or layout change.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/ServerUpdateAction.tsx`                    | MODIFY | `2b06bcf40a2193ec`           | User command guidance/search on web/desktop/mobile; no wire-contract or layout change.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/cloud/ConnectCliAuthSurface.tsx`           | MODIFY | `eeac8ce29b18d529`           | User command guidance/search on web/desktop/mobile; no wire-contract or layout change.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx` | MODIFY | `b3781a09eeef57ce`           | User command guidance/search on web/desktop/mobile; no wire-contract or layout change.                                                                                                                     |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.test.ts`                            | MODIFY | `7cc76254aa3ade63`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.test.ts`                       | MODIFY | `aa151cbf8fcc4cd6`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/pinnedRuntime.test.ts`                       | MODIFY | `7e46cd93154fdbdc`           | Existing install behavior now proves same-version upstream runtime is not reused/removed.                                                                                                                  |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/serviceLauncher.test.ts`                           | MODIFY | `e89270ea6c88db6a`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`                | MODIFY | `11c0471513a3784a`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`      | MODIFY | `bedc049b43f3f017`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-desktop-artifact.test.ts`                            | MODIFY | `1ab5c2d4ee0a106a`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.test.ts`                                   | MODIFY | `c6fa97205ad34fd5`           | Real shell probe/upload proves marker-only cache is missed and repaired while same-version upstream bytes survive; retain race and second-client lifecycle cases.                                          |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/update.test.ts`                                | MODIFY | `d637d5fe9544f17d`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/uninstall.test.ts`                             | MODIFY | `39e7d28021d68005`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliShim.test.ts`                       | MODIFY | `d6dd829282d01593`           | Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliCommand.test.ts`                    | MODIFY | `088c15c73138b4b1`           | Keep ownership behavior tests plus real GOAT/upstream coexistence and foreign-marker refusal.                                                                                                              |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/app.test.ts`                                   | MODIFY | `ef61487407bfba6f`           | Expected help/error/command output follows goat; preserve npm runner expectations.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/pair.test.ts`                                  | MODIFY | `67fe71df1b8c69f6`           | Expected help/error/command output follows goat; preserve npm runner expectations.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/service.test.ts`                               | MODIFY | `bfca6686f068571d`           | Expected help/error/command output follows goat; preserve npm runner expectations.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/preview/PreviewBrowserHost.test.ts`                | MODIFY | `64829e5de8a78752`           | Expected help/error/command output follows goat; preserve npm runner expectations.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/ServerUpdateAction.test.tsx`               | MODIFY | `311b31b0646e8f75`           | Expected help/error/command output follows goat; preserve npm runner expectations.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/invocation.test.ts`                            | MODIFY | `508def24793bb87a`           | Legacy npm ownership + new goat native bin ownership; version mismatch fails closed and foreign t3 survives.                                                                                               |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.test.ts`                                           | MODIFY | `f0d1346cae90baca`           | Real POSIX installer repairs marker-only GOAT cache, executes goat shim, preserves upstream same-version cache; HTTP failure/progress semantics remain tested.                                             |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/fixtures/remote-runner-baseline.json`             | MODIFY | `a3eaad24210bf8e6`           | Frozen runner/launch/pairing bytes change deliberately with executable/runtime namespace. This includes node override variants because wrapper script still embeds archive fallback.                       |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/install.md`                                              | MODIFY | `fa0f0dbfb73d5782`           | Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/background-service.md`                                   | MODIFY | `5f66d57b3ea918a5`           | Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/remote-access.md`                                        | MODIFY | `1373192c71cfca9d`           | Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/welcome-wizard.md`                                       | MODIFY | `010b8fa2f4a3e561`           | Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/updating.md`                                             | MODIFY | `8a08e5ab696e0bcb`           | Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.                                                                                                 |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/operations/release.md`                                        | MODIFY | `d70c4cc9cb505b7b`           | Document archive/executable and dual-bin contract in existing operational guidance; package publishing identity stays unchanged.                                                                           |

| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchive.test.ts` | MODIFY | `7692eea1d9326fd2` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/selfUpdate.test.ts` | MODIFY | `a71ec60dd51fd2bb` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/bootService.test.ts` | MODIFY | `a46c310b47dfaa25` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/relayResponse.test.ts` | MODIFY | `c393675458828f67` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/serviceLauncherClient.ts` | MODIFY | `aa49213296f7c388` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/server.ts` | MODIFY | `c0e793fa14cbd849` | Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install-windows.test.ts` | NEW | `N/A new file` | Real Windows installer/HTTP/ZIP, marker-only/broken/runnable cache, goat.cmd invocation, upstream preservation; explicit non-Windows skip. |

| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/web-preview.yml` | MODIFY | `6b3a4bee6fafc14d` | Preview deployment output and workflow guidance name the standalone goat pairing command; hosted preview execution/publishing is not authorized. |

## Core exact diffs

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/vite.config.ts`

SEA output name (including tsdown target suffixes).

```diff
--- a/apps/server/vite.config.ts
+++ b/apps/server/vite.config.ts
@@ -85,7 +85,7 @@
       ...(packExecutable
         ? {
             exe: {
-              fileName: "t3",
+              fileName: "goat",
               outDir: "dist-exe",
               ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
               // Node's SEA docs: `import()` does not work when useCodeCache is
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/package.json`

Keep npm/workspace name t3; expose both command names from source package.

```diff
--- a/apps/server/package.json
+++ b/apps/server/package.json
@@ -8,6 +8,7 @@
     "directory": "apps/server"
   },
   "bin": {
+    "goat": "./dist/bin.mjs",
     "t3": "./dist/bin.mjs"
   },
   "files": [
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.ts`

Shared archive filename; release repository is owned by wp2.

```diff
--- a/packages/shared/src/cliRelease.ts
+++ b/packages/shared/src/cliRelease.ts
@@ -51,7 +51,7 @@
 }

 export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
-  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
+  return `goat-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
 }

 const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-cli-archive.ts`

Archive stem, SEA input, packaged entry, signing/help diagnostics; runtime npm manifest and native resource-monitor names stay unchanged.

```diff
--- a/scripts/build-cli-archive.ts
+++ b/scripts/build-cli-archive.ts
@@ -1,7 +1,7 @@
 #!/usr/bin/env node
 /**
  * Packages the server single-executable into a self-contained per-platform
- * archive: the `t3` binary, the web client, the resource monitor, and a
+ * archive: the `goat` binary, the web client, the resource monitor, and a
  * production install of the native packages the bundle keeps external. The
  * archive is the unit every runtime installer downloads, so nothing in it may
  * require Node, npm, or a compiler on the machine that unpacks it.
@@ -9,7 +9,7 @@
  * Layout inside the archive (a single top-level directory named after the
  * archive stem):
  *
- *   t3 | t3.exe          the single-executable
+ *   goat | goat.exe          the single-executable
  *   client/              web app served by the server
  *   resource-monitor/    per-platform Rust helper, same paths as the npm package
  *   node_modules/        runtime externals (node-pty, msgpackr-extract, fff)
@@ -98,7 +98,7 @@
 }

 export function cliArchiveStem(version: string, platform: BuildPlatform, arch: BuildArch): string {
-  return `t3-${version}-${cliArchivePlatformKey(platform, arch)}`;
+  return `goat-${version}-${cliArchivePlatformKey(platform, arch)}`;
 }

 export function cliArchiveFileName(version: string, platform: BuildPlatform, arch: BuildArch) {
@@ -366,7 +366,7 @@
     ]),
     "notarytool submit",
   ).pipe(Effect.ensuring(fs.remove(notarizeZip, { force: true }).pipe(Effect.ignore)));
-  yield* Effect.log("[cli-archive] Notarized t3.");
+  yield* Effect.log("[cli-archive] Notarized goat.");
 });

 const WindowsSigningConfig = Config.all({
@@ -421,7 +421,7 @@
   );
 });

-/** Signs t3.exe through the same Azure Trusted Signing setup the installer uses. */
+/** Signs goat.exe through the same Azure Trusted Signing setup the installer uses. */
 const signWindowsExecutable = Effect.fn("signWindowsExecutable")(function* (
   executablePath: string,
 ) {
@@ -451,9 +451,9 @@
   ].join(" ");
   yield* runCommand(
     ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]),
-    "Invoke-TrustedSigning t3.exe",
-  );
-  yield* Effect.log("[cli-archive] Signed t3.exe (Azure Trusted Signing).");
+    "Invoke-TrustedSigning goat.exe",
+  );
+  yield* Effect.log("[cli-archive] Signed goat.exe (Azure Trusted Signing).");
 });

 const buildCliArchive = Effect.fn("buildCliArchive")(function* (input: {
@@ -467,14 +467,14 @@
   const path = yield* Path.Path;
   const repoRoot = yield* RepoRoot;
   const serverDir = path.join(repoRoot, "apps/server");
-  const executableName = input.platform === "win" ? "t3.exe" : "t3";
-  // tsdown suffixes cross-built executables with their target (t3-darwin-x64);
-  // a host build is plain t3. Prefer the exact target when both exist.
+  const executableName = input.platform === "win" ? "goat.exe" : "goat";
+  // tsdown suffixes cross-built executables with their target (goat-darwin-x64);
+  // a host build is plain goat. Prefer the exact target when both exist.
   const targetKey = `${input.platform === "mac" ? "darwin" : input.platform}-${input.arch}`;
   const targetExecutable = path.join(
     serverDir,
     "dist-exe",
-    `t3-${targetKey}${input.platform === "win" ? ".exe" : ""}`,
+    `goat-${targetKey}${input.platform === "win" ? ".exe" : ""}`,
   );
   // The unsuffixed host build is only a valid stand-in when it was built for
   // this platform and architecture; otherwise a missing target must fail.
@@ -581,7 +581,7 @@
     ),
   },
   (input) => buildCliArchive(input).pipe(Effect.scoped),
-).pipe(Command.withDescription("Package the t3 single-executable into a per-platform archive."));
+).pipe(Command.withDescription("Package the goat single-executable into a per-platform archive."));

 if (import.meta.main) {
   Command.run(command, { version: "0.0.0" }).pipe(
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.ts`

All npm package identities/filenames stay t3 and @t3code/t3-*; both bins invoke bin/t3.js, which executes goat/goat.exe.

```diff
--- a/scripts/build-npm-platform-packages.ts
+++ b/scripts/build-npm-platform-packages.ts
@@ -107,12 +107,12 @@
   return {
     name: npmPlatformPackageName(platformKey),
     version,
-    description: `T3 Code CLI executable for ${platformKey}`,
+    description: `GOAT CLI executable for ${platformKey}`,
     license: serverPackageJson.license,
     repository: serverPackageJson.repository,
     os: [os],
     cpu: [cpu],
-    files: ["t3", "t3.exe", "client", "resource-monitor", "node_modules"],
+    files: ["goat", "goat.exe", "client", "resource-monitor", "node_modules"],
     preferUnplugged: true,
     dependencies: Object.fromEntries(bundleDependencies.map((name) => [name, bundled[name]])),
     bundleDependencies,
@@ -155,7 +155,7 @@
   return [
     `# ${npmPlatformPackageName(platformKey)}`,
     "",
-    `The T3 Code CLI executable for ${platformKey}. Do not install this package directly:`,
+    `The GOAT CLI executable for ${platformKey}. Do not install this package directly:`,
     `it is an optional dependency of \`${NPM_LAUNCHER_PACKAGE_NAME}\`, which picks the package for the`,
     "current platform and runs the executable inside it.",
     "",
@@ -176,10 +176,10 @@
   return {
     name: NPM_LAUNCHER_PACKAGE_NAME,
     version,
-    description: "T3 Code CLI. Installs the self-contained executable for this platform.",
+    description: "GOAT CLI. Installs the self-contained executable for this platform.",
     license: serverPackageJson.license,
     repository: serverPackageJson.repository,
-    bin: { t3: "./bin/t3.js" },
+    bin: { goat: "./bin/t3.js", t3: "./bin/t3.js" },
     files: ["bin", "dist"],
     optionalDependencies: Object.fromEntries(
       platformKeys.map((key) => [npmPlatformPackageName(key), version]),
@@ -207,7 +207,7 @@
 } catch {
   process.stderr.write(
     [
-      "t3: no T3 Code CLI build is available for this platform (" + key + ").",
+      "goat: no GOAT CLI build is available for this platform (" + key + ").",
       "Supported platforms: " + SUPPORTED.join(", ") + ".",
       "If yours is listed, reinstall t3 so npm fetches its optional dependency.",
       "The desktop app and release archives are at https://github.com/goat-si/goat/releases",
@@ -217,10 +217,10 @@
   process.exit(1);
 }

-const executable = join(packageDir, process.platform === "win32" ? "t3.exe" : "t3");
+const executable = join(packageDir, process.platform === "win32" ? "goat.exe" : "goat");
 const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });
 if (result.error) {
-  process.stderr.write("t3: failed to start " + executable + ": " + result.error.message + "\\n");
+  process.stderr.write("goat: failed to start " + executable + ": " + result.error.message + "\\n");
   process.exit(1);
 }
 // A child killed by a signal has no status; report it the way a shell would.
@@ -332,7 +332,7 @@
   const extractDir = path.join(scratch, "extract");
   yield* fs.makeDirectory(extractDir);
   const contentDir = yield* extractArchive(input.archive, extractDir);
-  const executableName = input.key.startsWith("win32") ? "t3.exe" : "t3";
+  const executableName = input.key.startsWith("win32") ? "goat.exe" : "goat";
   const executable = path.join(contentDir, executableName);
   if (!(yield* fs.exists(executable))) {
     return yield* new NpmPackagesArchiveLayoutError({
@@ -341,7 +341,7 @@
     });
   }
   // The tarball carries the on-disk mode, so the bit must be set before packing.
-  if (executableName === "t3") {
+  if (executableName === "goat") {
     yield* fs.chmod(executable, 0o755);
   }
   const bundled = yield* readBundledPackages(path.join(contentDir, "node_modules"));
@@ -461,7 +461,7 @@
   "build-npm-platform-packages",
   {
     archivesDir: Flag.String("archives-dir").pipe(
-      Flag.withDescription("Directory holding the release's t3-<version>-<platform> archives."),
+      Flag.withDescription("Directory holding the release's goat-<version>-<platform> archives."),
     ),
     version: Flag.String("version").pipe(
       Flag.withDescription(
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/legacyCliLauncher.ts`

Legacy dist/bin.mjs forwards IPC/signals to renamed executable; keep npm package path.

```diff
--- a/packages/shared/src/legacyCliLauncher.ts
+++ b/packages/shared/src/legacyCliLauncher.ts
@@ -16,7 +16,7 @@
 import { dirname, join } from "node:path";
 import { createRequire } from "node:module";
 const require = createRequire(import.meta.url);
-const executableName = process.platform === "win32" ? "t3.exe" : "t3";
+const executableName = process.platform === "win32" ? "goat.exe" : "goat";
 const executable = join(dirname(require.resolve("@t3code/t3-" + process.platform + "-" + process.arch + "/package.json")), executableName);
 const ipc = process.send !== undefined;
 const child = spawn(executable, process.argv.slice(2), {
@@ -24,7 +24,7 @@
 });
 const fail = (error) => {
   if (!error) return;
-  process.stderr.write("t3: " + error.message + "\\n");
+  process.stderr.write("goat: " + error.message + "\\n");
   child.kill("SIGTERM");
   process.exitCode = 1;
 };
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/pinnedRuntime.ts`

Own runtime/goat/versions namespace protects an upstream runtime at the same home/version; marker remains .install-complete.

```diff
--- a/apps/server/src/cloud/pinnedRuntime.ts
+++ b/apps/server/src/cloud/pinnedRuntime.ts
@@ -21,8 +21,8 @@
 import * as ProcessRunner from "../processRunner.ts";

 /**
- * A pinned runtime is an exact t3 release archive unpacked into
- * <baseDir>/runtime/versions/<version>: the self-contained executable, the
+ * A pinned runtime is an exact GOAT release archive unpacked into
+ * <baseDir>/runtime/goat/versions/<version>: the self-contained executable, the
  * web client, and the native packages beside it. The boot service points its
  * unit or launch agent at the executable, and server self-update installs the
  * target version here before switching over. The runtime never depends on a
@@ -53,7 +53,7 @@
 }

 export function pinnedRuntimeVersionsDir(path: Path.Path, baseDir: string): string {
-  return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
+  return path.join(baseDir, PINNED_RUNTIME_DIR, "goat", "versions");
 }

 export function pinnedRuntimePaths(
@@ -65,7 +65,7 @@
   const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir), version);
   return {
     versionDir,
-    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
+    entryPath: path.join(versionDir, platform === "win32" ? "goat.exe" : "goat"),
     sentinelPath: path.join(versionDir, ".install-complete"),
   };
 }
@@ -104,7 +104,7 @@
   | { readonly stage: "verify" | "extract" | "validate" | "cached" };

 /**
- * Installs the t3 release archive for `version` into the pinned runtime
+ * Installs the GOAT release archive for `version` into the pinned runtime
  * directory unless a complete install is already there, and returns its
  * paths. The sentinel is written only after extraction and validation
  * succeed; checking the entry file alone is not enough, since tar writes the
@@ -189,7 +189,7 @@
   const platformKey = cliArchivePlatformKey(input.platform, input.arch);
   if (platformKey === undefined) {
     return yield* new PinnedRuntimeInstallError({
-      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
+      step: `selecting a GOAT release archive for ${input.platform}-${input.arch}`,
     });
   }
   const httpClient = input.httpClient;
@@ -202,31 +202,31 @@
       yield* fetchReleaseAsset(
         httpClient,
         `${baseUrl}/${CLI_RELEASE_CHECKSUMS_FILE}`,
-        "downloading the t3 release checksums",
+        "downloading the GOAT release checksums",
       ),
     ),
   );
   const expected = checksums.get(fileName);
   if (expected === undefined) {
     return yield* new PinnedRuntimeInstallError({
-      step: `finding ${fileName} in the t3 release checksums`,
+      step: `finding ${fileName} in the GOAT release checksums`,
     });
   }
   const archive = yield* fetchReleaseAsset(
     httpClient,
     `${baseUrl}/${fileName}`,
-    "downloading the t3 release archive",
+    "downloading the GOAT release archive",
     input.onProgress,
   );
   input.onProgress?.({ stage: "verify" });
   const digest = yield* Effect.tryPromise({
     try: () => crypto.subtle.digest("SHA-256", archive),
     catch: (cause) =>
-      new PinnedRuntimeInstallError({ step: "verifying the t3 release archive", cause }),
+      new PinnedRuntimeInstallError({ step: "verifying the GOAT release archive", cause }),
   });
   if (Hex.encode(new Uint8Array(digest)) !== expected) {
     return yield* new PinnedRuntimeInstallError({
-      step: "verifying the t3 release archive checksum",
+      step: "verifying the GOAT release archive checksum",
     });
   }

@@ -235,13 +235,13 @@
     .writeFile(archivePath, archive)
     .pipe(
       Effect.mapError(
-        (cause) => new PinnedRuntimeInstallError({ step: "writing the t3 release archive", cause }),
+        (cause) => new PinnedRuntimeInstallError({ step: "writing the GOAT release archive", cause }),
       ),
     );
   input.onProgress?.({ stage: "extract" });
-  const extractStep = "extracting the t3 release archive";
+  const extractStep = "extracting the GOAT release archive";
   // The archive wraps everything in one directory named after its stem;
-  // strip it so the executable lands at <versionDir>/t3.
+  // strip it so the executable lands at <versionDir>/goat.
   yield* input.runner
     .run({
       command: cliArchiveTarCommand(input.platform, process.env),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/serviceLauncher.ts`

Standalone Node-only launcher must mirror pinnedRuntimePaths; retain boot-service ids/protocol.

```diff
--- a/apps/server/src/serviceLauncher.ts
+++ b/apps/server/src/serviceLauncher.ts
@@ -47,9 +47,9 @@
 // executable runs on its own. Kept inline so this file stays on Node
 // built-ins only.
 const runtimePaths = (baseDir: string, version: string) => {
-  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
+  const versionDir = NodePath.join(baseDir, "runtime", "goat", "versions", version);
   // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
-  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
+  const executableName = process.platform === "win32" ? "goat.exe" : "goat";
   return {
     versionDir,
     entryPath: NodePath.join(versionDir, executableName),
@@ -368,7 +368,7 @@
   async #recover(): Promise<void> {
     // A fresh launcher means servers are running again: any stop marker from
     // a previous explicit stop is stale and must not make a future update
-    // handoff release its tunnel. A restart deferred by `t3 update` is done
+    // handoff release its tunnel. A restart deferred by `goat update` is done
     // no matter who restarted the service, but only once this launcher is
     // the version the marker waits for: a launcher that came up between the
     // CLI writing the marker and writing the new state still runs the old
@@ -416,7 +416,7 @@
   async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
     if (this.#stopping) return;
     if (!(await runtimeExists(this.#baseDir, version))) {
-      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
+      throw new Error(`Selected goat@${version} runtime is missing or incomplete.`);
     }
     if (this.#stopping) return;
     const paths = runtimePaths(this.#baseDir, version);
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts`

Rename archive/entry in runner, upload installer and probe together; runtime namespace protects same-version upstream cache. Remote state/server home move to `~/.goat` through mandatory D7-A inside wp4.

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@ -507,22 +507,22 @@
 fi
 T3_ARCHIVE_VERSION=@@T3_ARCHIVE_VERSION@@
 if [ -z "$T3_ARCHIVE_VERSION" ]; then
-  printf 'No t3 release version was provided for the remote runtime.\\n' >&2
+  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2
   exit 1
 fi
 # Self-contained release archive: no Node, npm, or compiler on the remote.
-# Unpacked into the pinned-runtime layout so \`t3 service install\` reuses it.
+# Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
 T3_RELEASE_BASE_URL=@@T3_RELEASE_BASE_URL@@
-T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"
+T3_RUNTIME_DIR="$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION"
 t3_runtime_ready() {
-  [ -x "$T3_RUNTIME_DIR/t3" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]
+  [ -x "$T3_RUNTIME_DIR/goat" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]
 }
 if ! t3_runtime_ready; then
-  mkdir -p "$HOME/.t3/runtime/versions"
+  mkdir -p "$HOME/.t3/runtime/goat/versions"
   # Concurrent launches (two clients, a retry racing a slow first run) must
   # not both install: mkdir is the atomic lock and the ready check repeats
   # under it.
-  T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"
+  T3_LOCK="$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"
   # mkdir is the only portable atomic exclusive create (mv would silently
   # nest a candidate inside an existing lock). The owner publishes its pid
   # right after, so a lock with a live owner is never reclaimed however
@@ -548,7 +548,7 @@
       fi
     fi
     if [ "$T3_LOCK_WAITED" -ge @@T3_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
-      printf 'Another t3 %s installation has held %s for too long.\\n' "$T3_ARCHIVE_VERSION" "$T3_LOCK" >&2
+      printf 'Another GOAT %s installation has held %s for too long.\\n' "$T3_ARCHIVE_VERSION" "$T3_LOCK" >&2
       exit 1
     fi
     sleep 1
@@ -561,15 +561,15 @@
   case "$(uname -s)" in
     Darwin) T3_PLATFORM="darwin" ;;
     Linux) T3_PLATFORM="linux" ;;
-    *) printf 'Remote host %s has no t3 release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
+    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
   esac
   case "$(uname -m)" in
     arm64 | aarch64) T3_ARCH="arm64" ;;
     x86_64 | amd64) T3_ARCH="x64" ;;
-    *) printf 'Remote host %s has no t3 release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
+    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
   esac
-  T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"
-  T3_STAGING="$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")"
+  T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"
+  T3_STAGING="$(mktemp -d "$HOME/.t3/runtime/goat/versions/.staging-XXXXXX")"
   trap 'rm -rf "$T3_STAGING" "$T3_LOCK"' EXIT
   t3_fetch() {
     if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
@@ -592,8 +592,8 @@
   rm -f "$T3_STAGING/$T3_ARCHIVE" "$T3_STAGING/SHA256SUMS"
   # Prove the binary runs here (libc, arch) before marking it ready, or every
   # later launch would exec a broken install instead of retrying.
-  if ! "$T3_STAGING/t3" --version >/dev/null 2>&1; then
-    printf 'The t3 %s executable does not run on this host.\\n' "$T3_ARCHIVE_VERSION" >&2; exit 1
+  if ! "$T3_STAGING/goat" --version >/dev/null 2>&1; then
+    printf 'The goat %s executable does not run on this host.\\n' "$T3_ARCHIVE_VERSION" >&2; exit 1
   fi
   printf '%s\\n' "$T3_ARCHIVE_VERSION" > "$T3_STAGING/.install-complete"
   rm -rf "$T3_RUNTIME_DIR"
@@ -603,7 +603,7 @@
   rm -rf "$T3_LOCK"
   trap - EXIT
 fi
-exec "$T3_RUNTIME_DIR/t3" "$@"
+exec "$T3_RUNTIME_DIR/goat" "$@"
 `;

 const REMOTE_LAUNCH_SCRIPT = `set -eu
@@ -893,7 +893,7 @@
   { archiveVersion: Schema.String },
 ) {
   override get message(): string {
-    return `'${this.archiveVersion}' is not an exact t3 version and cannot name a runtime directory.`;
+    return `'${this.archiveVersion}' is not an exact GOAT version and cannot name a runtime directory.`;
   }
 }

@@ -908,7 +908,7 @@
   {},
 ) {
   override get message(): string {
-    return "A remote t3 runner needs an archive version or a node script path.";
+    return "A remote goat runner needs an archive version or a node script path.";
   }
 }

@@ -1046,8 +1046,8 @@
   const installer = buildRemoteT3UploadInstallerScript(input, sha256);
   return `set -eu
 umask 077
-mkdir -p "$HOME/.t3/runtime/versions"
-upload_dir="$(mktemp -d "$HOME/.t3/runtime/versions/.upload-XXXXXX")"
+mkdir -p "$HOME/.t3/runtime/goat/versions"
+upload_dir="$(mktemp -d "$HOME/.t3/runtime/goat/versions/.upload-XXXXXX")"
 trap 'rm -rf "$upload_dir"' EXIT
 trap 'exit 1' HUP INT TERM
 cat > "$upload_dir/archive.tar.gz"
@@ -1095,9 +1095,9 @@
   x86_64|amd64) arch=x64 ;;
   *) printf 'Unsupported SSH runtime architecture.\\n' >&2; exit 1 ;;
 esac
-runtime="$HOME/.t3/runtime/versions/$V"
+runtime="$HOME/.t3/runtime/goat/versions/$V"
 ready=false
-if [ -x "$runtime/t3" ] && [ "$(cat "$runtime/.install-complete" 2>/dev/null)" = "$V" ]; then
+if [ -x "$runtime/goat" ] && [ "$(cat "$runtime/.install-complete" 2>/dev/null)" = "$V" ]; then
   ready=true
 fi
 printf '{"platform":"%s","arch":"%s","ready":%s%s}\\n' "$platform" "$arch" "$ready" "$retained_fields"
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.sh`

Own goat shim and runtime namespace; marker alone is insufficient. Keep T3CODE_HOME default and npm fallback package identity.

```diff
--- a/scripts/install.sh
+++ b/scripts/install.sh
@@ -1,19 +1,19 @@
 #!/bin/sh
-# Installs the T3 Code CLI from a GitHub Release archive. Needs only sh, tar,
+# Installs the GOAT CLI from a GitHub Release archive. Needs only sh, tar,
 # sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
 #
-#   curl -fsSL https://t3.codes/install.sh | sh
+#   curl -fsSL https://goat.codes/install.sh | sh
 #
 # Environment:
 #   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
 #                            (default: stable; preview is a maintainers' test train)
 #   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
 #   T3CODE_HOME              T3 home directory (default: ~/.t3)
-#   T3CODE_INSTALL_BIN_DIR   where the `t3` symlink goes (default: ~/.local/bin)
+#   T3CODE_INSTALL_BIN_DIR   where the `goat` symlink goes (default: ~/.local/bin)
 #   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
 #
-# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
-# same layout `t3 service install` uses, so the service reuses this download
+# The archive is unpacked into $T3CODE_HOME/runtime/goat/versions/<version>, the
+# same layout `goat service install` uses, so the service reuses this download
 # instead of fetching the release again.
 set -eu

@@ -162,7 +162,7 @@
 case "$version" in
   *-preview.*)
     printf '%s\n' \
-      "t3 ${version} is a preview build." \
+      "goat ${version} is a preview build." \
       "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
       "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
       "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
@@ -172,12 +172,15 @@
     ;;
 esac

-stem="t3-${version}-${platform}-${arch}"
+stem="goat-${version}-${platform}-${arch}"
 archive="${stem}.tar.gz"
-versions_dir="${t3_home}/runtime/versions"
+versions_dir="${t3_home}/runtime/goat/versions"
 target_dir="${versions_dir}/${version}"

-if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
+if [ -x "${target_dir}/goat" ] &&
+   [ -f "${target_dir}/.install-complete" ] &&
+   [ "$(cat "${target_dir}/.install-complete")" = "$version" ] &&
+   "${target_dir}/goat" --version >/dev/null 2>&1; then
   step "Version ${version} is already downloaded."
 else
   mkdir -p "$versions_dir"
@@ -188,12 +191,12 @@
   trap 'printf "\n" >&2; exit 143' TERM

   if "$interactive"; then printf '\r\033[2K' >&2; fi
-  printf '  %sInstalling%s T3 Code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
+  printf '  %sInstalling%s GOAT %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
   step "Downloading..."
   fetch_status=0
   fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
   if [ "$fetch_status" -eq 44 ]; then
-    fail "t3 ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g t3@${version}\`"
+    fail "goat ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g t3@${version}\`"
   elif [ "$fetch_status" -ne 0 ]; then
     fail "could not download the release checksums"
   fi
@@ -205,10 +208,10 @@
   actual="$(checksum "${staging}/${archive}")"
   [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

-  step "Extracting T3 Code..."
+  step "Extracting GOAT..."
   tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
   rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
-  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
+  "${staging}/goat" --version >/dev/null || fail "the downloaded executable does not run"
   printf '%s\n' "$version" > "${staging}/.install-complete"

   rm -rf "$target_dir"
@@ -216,12 +219,12 @@
   trap - EXIT
 fi

-step "Setting up the t3 command..."
+step "Setting up the goat command..."
 mkdir -p "$bin_dir"
-ln -sfn "${target_dir}/t3" "${bin_dir}/t3"
+ln -sfn "${target_dir}/goat" "${bin_dir}/goat"
 if "$interactive"; then printf '\r\033[2K' >&2; fi
-printf '  %sInstalled T3 Code %s%s\n\n' "$green" "$version" "$reset" >&2
+printf '  %sInstalled GOAT %s%s\n\n' "$green" "$version" "$reset" >&2
 case ":${PATH}:" in
-  *":${bin_dir}:"*) printf '  Run %st3%s to get started.\n\n' "$bold" "$reset" ;;
-  *) printf '  Add %s to your PATH, then run %st3%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
-esac
+  *":${bin_dir}:"*) printf '  Run %sgoat%s to get started.\n\n' "$bold" "$reset" ;;
+  *) printf '  Add %s to your PATH, then run %sgoat%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
+esac
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.ps1`

Own goat shim and runtime namespace; marker alone is insufficient. Keep T3CODE_HOME default and npm fallback package identity.

```diff
--- a/scripts/install.ps1
+++ b/scripts/install.ps1
@@ -1,18 +1,18 @@
-# Installs the T3 Code CLI from a GitHub Release archive on Windows. Needs
+# Installs the GOAT CLI from a GitHub Release archive on Windows. Needs
 # only PowerShell 5.1+; no Node, npm, or compiler.
 #
-#   irm https://t3.codes/install.ps1 | iex
+#   irm https://goat.codes/install.ps1 | iex
 #
 # Environment:
 #   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
 #                            (default: stable; preview is a maintainers' test train)
 #   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
 #   T3CODE_HOME              T3 home directory (default: ~\.t3)
-#   T3CODE_INSTALL_BIN_DIR   where t3.exe is linked (default: ~\.local\bin)
+#   T3CODE_INSTALL_BIN_DIR   where goat.exe is linked (default: ~\.local\bin)
 #   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
 #
-# The archive is unpacked into $T3CODE_HOME\runtime\versions\<version>, the
-# same layout `t3 service install` uses, so the service reuses this download.
+# The archive is unpacked into $T3CODE_HOME\runtime\goat\versions\<version>, the
+# same layout `goat service install` uses, so the service reuses this download.
 $ErrorActionPreference = "Stop"
 [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

@@ -22,7 +22,7 @@
 $binDir = if ($env:T3CODE_INSTALL_BIN_DIR) { $env:T3CODE_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }

 function Fail([string] $message) {
-  Write-Error "t3 install: $message"
+  Write-Error "goat install: $message"
   exit 1
 }

@@ -139,25 +139,33 @@
     "preview" { '^v\d+\.\d+\.\d+-preview\.\d+\.\d+$' }
     default { Fail "T3CODE_CHANNEL must be stable, nightly, or preview" }
   }
-  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "t3-install" }
+  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "goat-install" }
   $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match $tagPattern } | Select-Object -First 1).tag_name
   if (-not $tag) { Fail "could not find a $channel release; set T3CODE_VERSION" }
   $version = $tag.Substring(1)
 }
 if ($version -match '-preview\.') {
-  Write-Warning "t3 $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set T3CODE_CHANNEL=stable (the default) for a supported build."
+  Write-Warning "goat $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set T3CODE_CHANNEL=stable (the default) for a supported build."
   if ($channel -ne "preview" -and -not $env:T3CODE_VERSION) {
     Fail "refusing a preview build that was not explicitly requested"
   }
 }

-$stem = "t3-$version-win32-$arch"
+$stem = "goat-$version-win32-$arch"
 $archive = "$stem.zip"
-$versionsDir = Join-Path $t3Home "runtime\versions"
+$versionsDir = Join-Path $t3Home "runtime\goat\versions"
 $targetDir = Join-Path $versionsDir $version
 $marker = Join-Path $targetDir ".install-complete"

-if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $version)) {
+$entry = Join-Path $targetDir "goat.exe"
+$cached = (Test-Path $marker -PathType Leaf) -and (Test-Path $entry -PathType Leaf) -and ((Get-Content $marker -Raw).Trim() -eq $version)
+if ($cached) {
+  try {
+    & $entry --version | Out-Null
+    $cached = $LASTEXITCODE -eq 0
+  } catch { $cached = $false }
+}
+if ($cached) {
   Step "Version $version is already downloaded."
 } else {
   New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
@@ -165,14 +173,14 @@
   New-Item -ItemType Directory -Path $staging | Out-Null
   try {
     if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
-    [Console]::Error.WriteLine("  ${muted}Installing$reset T3 Code $bold$version$reset`n")
+    [Console]::Error.WriteLine("  ${muted}Installing$reset GOAT $bold$version$reset`n")
     Step "Downloading..."
     try {
       Fetch "$baseUrl/v$version/SHA256SUMS" (Join-Path $staging "SHA256SUMS")
     } catch {
       $status = $_.Exception.Response.StatusCode.value__
       if ($status -eq 404) {
-        Fail "t3 $version has no release archive for win32-$arch; releases before the self-contained CLI can only be installed with 'npm install -g t3@$version'"
+        Fail "goat $version has no release archive for win32-$arch; releases before the self-contained CLI can only be installed with 'npm install -g t3@$version'"
       }
       throw
     }
@@ -186,7 +194,7 @@
     $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $archive)).Hash.ToLowerInvariant()
     if ($actual -ne $expected) { Fail "checksum mismatch for $archive" }

-    Step "Extracting T3 Code..."
+    Step "Extracting GOAT..."
     # The archive module reads the global preference, not the caller's local scope.
     $savedProgress = $global:ProgressPreference
     try {
@@ -197,7 +205,7 @@
     Get-ChildItem (Join-Path $staging $stem) | Move-Item -Destination $staging
     Remove-Item (Join-Path $staging $stem), (Join-Path $staging $archive), (Join-Path $staging "SHA256SUMS") -Recurse -Force

-    & (Join-Path $staging "t3.exe") --version | Out-Null
+    & (Join-Path $staging "goat.exe") --version | Out-Null
     if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable does not run" }
     Set-Content -Path (Join-Path $staging ".install-complete") -Value $version -NoNewline

@@ -209,16 +217,16 @@
   }
 }

-Step "Setting up the t3 command..."
+Step "Setting up the goat command..."
 New-Item -ItemType Directory -Force -Path $binDir | Out-Null
-$shim = Join-Path $binDir "t3.cmd"
+$shim = Join-Path $binDir "goat.cmd"
 # UTF-8 without a BOM: cmd.exe reads the shim as-is, and ASCII would corrupt
 # non-ASCII characters in the user's home path.
-[System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$(Join-Path $targetDir 't3.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
+[System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$(Join-Path $targetDir 'goat.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
 if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
-[Console]::Error.WriteLine("  ${green}Installed T3 Code $version$reset`n")
+[Console]::Error.WriteLine("  ${green}Installed GOAT $version$reset`n")
 if (($env:PATH -split ";") -notcontains $binDir) {
-  Write-Host "  Add $binDir to your PATH, then run ${bold}t3$reset.`n"
+  Write-Host "  Add $binDir to your PATH, then run ${bold}goat$reset.`n"
 } else {
-  Write-Host "  Run ${bold}t3$reset to get started.`n"
-}
+  Write-Host "  Run ${bold}goat$reset to get started.`n"
+}
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliShim.ts`

Unique GOAT ownership marker. Never accept legacy upstream marker or touch bin/t3; retain T3CODE_CLI_PATH/T3CODE_HOME.

```diff
--- a/apps/desktop/src/app/DesktopCliShim.ts
+++ b/apps/desktop/src/app/DesktopCliShim.ts
@@ -6,15 +6,15 @@
 import * as DesktopEnvironment from "./DesktopEnvironment.ts";
 import { makeComponentLogger } from "./DesktopObservability.ts";

-// A desktop install puts no `t3` on PATH, so commands the server asks a person
-// to run (`sudo t3 browser setup`) had nothing to call. The app keeps a small
+// A desktop install puts no `goat` on PATH, so commands the server asks a person
+// to run (`sudo goat browser setup`) had nothing to call. The app keeps a small
 // launcher for its bundled CLI in the T3 home, which is never on PATH and so
-// never shadows another `t3`, and the server names it by absolute path in those
+// never shadows another `goat`, and the server names it by absolute path in those
 // commands through T3CODE_CLI_PATH. An AppImage mounts somewhere new each run,
 // so its launcher mounts the AppImage itself instead of pointing into it.
 const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

-export const MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";
+export const MARKER = "Written by GOAT: runs the desktop app's bundled goat CLI.";

 /** Server entry inside the app, relative to its server root (an asar archive when packaged). */
 const SERVER_ENTRY = "apps/server/dist/bin.mjs";
@@ -125,12 +125,12 @@
   ].join("\n");
 };

-/** Where the packaged app keeps its launcher: `<T3 home>/bin/t3`, `t3.cmd` on Windows. */
+/** Where the packaged app keeps its launcher: `<T3 home>/bin/goat`, `goat.cmd` on Windows. */
 export const launcherPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
   environment.path.join(
     environment.baseDir,
     "bin",
-    environment.platform === "win32" ? "t3.cmd" : "t3",
+    environment.platform === "win32" ? "goat.cmd" : "goat",
   );

 /**
@@ -162,23 +162,23 @@
   return yield* Effect.gen(function* () {
     const existing = yield* fs.readFileString(shimPath).pipe(Effect.option);
     if (Option.isSome(existing) && !existing.value.includes(MARKER)) {
-      // Someone else's file; leave it, and let commands fall back to plain `t3`.
-      yield* logWarning("leaving a t3 launcher the app did not write", { shimPath });
+      // Someone else's file; leave it, and let commands fall back to plain `goat`.
+      yield* logWarning("leaving a goat launcher the app did not write", { shimPath });
       return Option.none<string>();
     }
     if (Option.getOrUndefined(existing) !== content) {
       yield* fs.makeDirectory(path.dirname(shimPath), { recursive: true });
-      // Written beside the launcher and renamed over it, so a running `t3` never reads half a file.
+      // Written beside the launcher and renamed over it, so a running `goat` never reads half a file.
       const staging = `${shimPath}.${process.pid}.tmp`;
       yield* fs.writeFileString(staging, content, { mode: 0o755 });
       yield* fs.rename(staging, shimPath);
-      yield* logInfo("installed t3 launcher", { shimPath });
+      yield* logInfo("installed goat launcher", { shimPath });
     }
     return Option.some(shimPath);
   }).pipe(
-    // Best-effort: nothing here may block the backend's start; commands then fall back to plain `t3`.
+    // Best-effort: nothing here may block the backend's start; commands then fall back to plain `goat`.
     Effect.catchCause((cause) =>
-      logWarning("could not install t3 launcher", { shimPath, cause: Cause.pretty(cause) }).pipe(
+      logWarning("could not install goat launcher", { shimPath, cause: Cause.pretty(cause) }).pipe(
         Effect.as(Option.none<string>()),
       ),
     ),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliCommand.ts`

Install/remove only goat links with GOAT marker; namespace Windows PATH ownership receipt so old upstream receipt cannot authorize removal.

```diff
--- a/apps/desktop/src/app/DesktopCliCommand.ts
+++ b/apps/desktop/src/app/DesktopCliCommand.ts
@@ -12,7 +12,7 @@
 import * as DesktopCliShim from "./DesktopCliShim.ts";
 import * as DesktopEnvironment from "./DesktopEnvironment.ts";

-// Settings → Install `t3` command, like VS Code's "Install 'code' command".
+// Settings → Install `goat` command, like VS Code's "Install 'code' command".
 // The app's launcher (see DesktopCliShim) lives in the T3 home and is off PATH
 // by default. Installing links it into a folder on the user's PATH, or on
 // Windows adds the launcher's folder to the user's PATH. Removing undoes only
@@ -83,7 +83,7 @@
   const launcher = DesktopCliShim.launcherPath(environment);
   const binDirectory = path.dirname(launcher);
   /** Records that Install added `binDirectory` to the Windows PATH, so Remove takes out only that. */
-  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");
+  const ownedPathMarker = path.join(environment.stateDir, "goat-cli-command-path-entry");

   const fail = (message: string) => new DesktopCliCommandError({ message });
   const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
@@ -101,7 +101,7 @@
   const isOurLink = (link: string) =>
     Effect.gen(function* () {
       yield* fs.readLink(link);
-      // The launcher is a few KB; never read a large binary another `t3` links to.
+      // The launcher is a few KB; never read a large binary another `goat` links to.
       const info = yield* fs.stat(link);
       if (info.type !== "File" || Number(info.size) > 16_384) return false;
       const content = yield* fs.readFileString(link);
@@ -137,16 +137,16 @@
       Effect.mapError(() => fail("Could not update your PATH.")),
     );

-  /** The `t3` a new shell runs, by PATH order, or none. */
+  /** The `goat` a new shell runs, by PATH order, or none. */
   const firstOnPath = Effect.gen(function* () {
     for (const directory of pathEntries(process.env.PATH, ":")) {
-      const candidate = path.join(directory, "t3");
+      const candidate = path.join(directory, "goat");
       if (yield* exists(candidate)) return Option.some(candidate);
     }
     return Option.none<string>();
   });

-  /** The `t3` a new shell runs when it is not this app's, on Unix. */
+  /** The `goat` a new shell runs when it is not this app's, on Unix. */
   const foreignFirstOnPath = Effect.gen(function* () {
     if (windows) return Option.none<string>();
     const first = yield* firstOnPath;
@@ -164,7 +164,7 @@
         : Option.none<string>();
     }
     for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
-      const link = path.join(directory, "t3");
+      const link = path.join(directory, "goat");
       if (yield* isOurLink(link)) return Option.some(link);
     }
     return Option.none<string>();
@@ -181,7 +181,7 @@
       return { supported: true, installedPath: null, onPath: false, ...shadow };
     }
     // On Windows only terminals opened after the change see it. On Unix the
-    // first `t3` on PATH must be ours; a `t3` earlier on PATH would shadow it.
+    // first `goat` on PATH must be ours; a `goat` earlier on PATH would shadow it.
     const first = yield* firstOnPath;
     const onPath = windows || (Option.isSome(first) && (yield* isOurLink(first.value)));
     return { supported: true, installedPath: installed.value, onPath, ...shadow };
@@ -193,14 +193,14 @@
     Effect.provideService(FileSystem.FileSystem, fs),
     Effect.flatMap(
       Option.match({
-        onNone: () => Effect.fail(fail(`Could not set up the t3 launcher at ${launcher}.`)),
+        onNone: () => Effect.fail(fail(`Could not set up the goat launcher at ${launcher}.`)),
         onSome: () => Effect.void,
       }),
     ),
   );

   const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
-    if (!environment.isPackaged) return yield* fail("The t3 command needs an installed app.");
+    if (!environment.isPackaged) return yield* fail("The goat command needs an installed app.");
     yield* ensureLauncher;
     if (windows) {
       const entries = pathEntries(yield* readUserPath, ";");
@@ -208,7 +208,7 @@
         yield* writeUserPath([...entries, binDirectory].join(";"));
         yield* fs
           .writeFileString(ownedPathMarker, `${binDirectory}\n`)
-          .pipe(Effect.mapError(() => fail("Added t3 to your PATH but could not record it.")));
+          .pipe(Effect.mapError(() => fail("Added goat to your PATH but could not record it.")));
       }
       return yield* state;
     }
@@ -221,11 +221,11 @@
         .remove(existing.value)
         .pipe(Effect.mapError(() => fail(`Could not replace ${existing.value}.`)));
     }
-    // A link behind another `t3` never runs, so installing one would only hide the problem.
+    // A link behind another `goat` never runs, so installing one would only hide the problem.
     const shadowedBy = yield* foreignFirstOnPath;
     if (Option.isSome(shadowedBy)) {
       return yield* fail(
-        `Another t3 at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
+        `Another goat at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
       );
     }
     const onPath = pathEntries(process.env.PATH, ":");
@@ -235,7 +235,7 @@
       ...candidates.filter((candidate) => onPath.includes(candidate)),
       ...candidates.filter((candidate) => !onPath.includes(candidate)),
     ]) {
-      const link = path.join(directory, "t3");
+      const link = path.join(directory, "goat");
       const created = (yield* exists(directory))
         ? yield* writableDirectory(directory)
         : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
@@ -251,7 +251,7 @@
       if (linked) return yield* state;
     }
     return yield* fail(
-      `Another t3 command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
+      `Another goat command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
     );
   }).pipe(Effect.withSpan("desktop.cliCommand.install"));

@@ -266,7 +266,7 @@
       return yield* state;
     }
     for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
-      const link = path.join(directory, "t3");
+      const link = path.join(directory, "goat");
       if (yield* isOurLink(link)) {
         yield* fs.remove(link).pipe(Effect.mapError(() => fail(`Could not remove ${link}.`)));
       }
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/wsl/DesktopWslEnvironment.ts`

WSL executable checks, digest, preflight and backend invocation all use goat; archive hash identities/WSL marker names remain.

```diff
--- a/apps/desktop/src/wsl/DesktopWslEnvironment.ts
+++ b/apps/desktop/src/wsl/DesktopWslEnvironment.ts
@@ -121,7 +121,7 @@
     readonly pruneRuntimes: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
     // Marks a staged runtime as unusable so the next launch reinstalls it.
     readonly invalidateRuntime: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
-    // Proves a staged self-contained runtime can run (`<root>/t3 --version`)
+    // Proves a staged self-contained runtime can run (`<root>/goat --version`)
     // and resolves the user's PATH, including version-managed Node for provider
     // CLIs. Node is optional; the mounted tree still requires ensureNodePty.
     readonly probeRuntime: (
@@ -276,7 +276,7 @@

 const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

-// Holds the sha256 of the runtime's `t3` executable, written when the install
+// Holds the sha256 of the runtime's `goat` executable, written when the install
 // promotes a verified tree. Presence alone only says an install once finished
 // here; the digest is what lets a later launch prove the entry still is what
 // that install wrote.
@@ -300,21 +300,21 @@
     'runtime_parent="$HOME/.t3/wsl-runtime"',
     `runtime_root="$runtime_parent/${safeRuntimeId}"`,
     `ready_marker="$runtime_root/${WSL_RUNTIME_READY_MARKER}"`,
-    // The runtime is a self-contained `t3` executable with Node inside, so the
+    // The runtime is a self-contained `goat` executable with Node inside, so the
     // readiness proof is the same one the SSH runner and the CLI installers
-    // use: the file is executable and `t3 --version` exits 0. That covers the
+    // use: the file is executable and `goat --version` exits 0. That covers the
     // truncated-binary and wrong-arch cases without a separate native probe.
     "runtime_entry_runs() {",
-    '  [ -x "$1/t3" ] && "$1/t3" --version >/dev/null 2>&1',
+    '  [ -x "$1/goat" ] && "$1/goat" --version >/dev/null 2>&1',
     "}",
-    // Hashing the entry is what tells a working cache from one whose `t3` was
+    // Hashing the entry is what tells a working cache from one whose `goat` was
     // swapped or half-written after install: the file is still there and may
     // even still run, and launch then picks an executable that is not what
     // this install verified. Hashing the executable measures in tens of
     // milliseconds inside the distro, once per launch, against a cold
     // reinstall of a few hundred megabytes.
     "runtime_server_entry_digest() {",
-    `  sha256sum "$1/t3" 2>/dev/null | cut -d ' ' -f 1`,
+    `  sha256sum "$1/goat" 2>/dev/null | cut -d ' ' -f 1`,
     "}",
     "runtime_is_ready() {",
     '  [ -f "$ready_marker" ] &&',
@@ -381,14 +381,14 @@
     `runtime_tmp=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.tmp.XXXXXX")`,
     'cleanup_runtime_install() { rm -rf "$runtime_tmp"; }',
     "trap cleanup_runtime_install EXIT",
-    // The release archive has one top-level `t3-<version>-linux-<arch>/`
-    // directory; strip it so the executable lands at `$runtime_root/t3`.
+    // The release archive has one top-level `goat-<version>-linux-<arch>/`
+    // directory; strip it so the executable lands at `$runtime_root/goat`.
     `tar -xzf ${shellQuote(linuxArchivePath)} -C "$runtime_tmp" --strip-components=1`,
     // Never write the ready marker over a tree whose executable does not run.
     // Failing here drops out to the mounted-tree fallback, which is
     // recoverable; promoting it would mark the defect ready and cache it.
     'if ! runtime_entry_runs "$runtime_tmp"; then',
-    "  printf 'WSL runtime archive does not contain a working t3 executable\\n' >&2",
+    "  printf 'WSL runtime archive does not contain a working goat executable\\n' >&2",
     "  exit 1",
     "fi",
     // The archive's bytes were verified against archiveSha256 above, so the
@@ -551,7 +551,7 @@
 export const buildWslRuntimeProbeScript = (linuxAppRoot: string) =>
   [
     `bash -lc ${shellQuote(`${buildWslNodeEnvPreamble()}${RESOLVED_PATH_LINE}`)} 2>/dev/null || ${RESOLVED_PATH_LINE}`,
-    `${shellQuote(`${linuxAppRoot}/t3`)} --version >/dev/null 2>&1`,
+    `${shellQuote(`${linuxAppRoot}/goat`)} --version >/dev/null 2>&1`,
   ].join("\n");

 const TOOLCHAIN_CHECK_SCRIPT = [
@@ -694,7 +694,7 @@
       const trimmedTail = probe.stderr.trim().slice(-500);
       return {
         ok: false,
-        reason: `${linuxAppRoot}/t3 --version failed (exit ${probe.exitCode})${trimmedTail ? `: ${trimmedTail}` : ""}`,
+        reason: `${linuxAppRoot}/goat --version failed (exit ${probe.exitCode})${trimmedTail ? `: ${trimmedTail}` : ""}`,
       } as const;
     }
     const resolvedPath = parseResolvedPath(probe.stdout);
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/backend/DesktopBackendConfiguration.ts`

WSL executable checks, digest, preflight and backend invocation all use goat; archive hash identities/WSL marker names remain.

```diff
--- a/apps/desktop/src/backend/DesktopBackendConfiguration.ts
+++ b/apps/desktop/src/backend/DesktopBackendConfiguration.ts
@@ -271,7 +271,7 @@
 }

 // What the launch runs inside the distro. The staged runtime is the release's
-// self-contained `t3` executable (Node inside); the mounted server tree is a
+// self-contained `goat` executable (Node inside); the mounted server tree is a
 // script that needs the distro's own Node.
 type WslPreflightRuntime =
   | {
@@ -448,7 +448,7 @@
           _tag: "Ready",
           runningDistro,
           windowsEntryPath: environment.backendEntryPath,
-          runtime: { kind: "executable", entryPath: `${runtime.linuxAppRoot}/t3` },
+          runtime: { kind: "executable", entryPath: `${runtime.linuxAppRoot}/goat` },
           resolvedPath: stagedProbe.resolvedPath,
           runtimeId: input.runtimeArchive.runtimeId,
         } as const;
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-desktop-artifact.ts`

WSL archive stem/member preflight; leave Electron/native helper ids intact.

```diff
--- a/scripts/build-desktop-artifact.ts
+++ b/scripts/build-desktop-artifact.ts
@@ -1088,7 +1088,7 @@
   to: WSL_RUNTIME_ARCHIVE_HASH_NAME,
 } as const;

-// The WSL runtime is the Linux CLI release archive (t3-<version>-linux-<arch>
+// The WSL runtime is the Linux CLI release archive (goat-<version>-linux-<arch>
 // .tar.gz, built by scripts/build-cli-archive.ts) copied in verbatim, so WSL
 // runs the exact bytes a Linux user downloads. This one predicate decides both
 // whether the archive is staged and whether the packaging config ships it:
@@ -1678,7 +1678,7 @@
   verbose: Config.Boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
   mockUpdates: Config.Boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
   mockUpdateServerPort: Config.String("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
-  // Path to the Linux CLI release archive (t3-<version>-linux-x64.tar.gz) built
+  // Path to the Linux CLI release archive (goat-<version>-linux-x64.tar.gz) built
   // by the build_linux_cli CI job. The Windows build embeds it verbatim as the
   // WSL runtime.
   wslRuntime: Config.String("T3CODE_DESKTOP_WSL_RUNTIME").pipe(Config.option),
@@ -3020,7 +3020,7 @@
 // this module, so it cannot be imported here). WSL runs the same CPU arch as
 // the Windows host.
 export const wslRuntimeArchiveStem = (version: string, arch: typeof BuildArch.Type): string =>
-  `t3-${version}-linux-${arch}`;
+  `goat-${version}-linux-${arch}`;

 export const parseWslRuntimeArchiveMembers = (listing: string): ReadonlyArray<string> =>
   listing
@@ -3300,7 +3300,7 @@
   readonly appExecutableName: string;
   readonly targetArch: typeof BuildArch.Type;
   // The version the embedded Linux CLI archive must carry; its top-level
-  // directory is named t3-<version>-linux-<arch>.
+  // directory is named goat-<version>-linux-<arch>.
   readonly appVersion: string;
   readonly expectWslRuntime?: boolean;
   readonly fileLimit?: number;
@@ -3466,7 +3466,7 @@
     }
     const members = parseWslRuntimeArchiveMembers(listing.stdout);
     // A release archive unpacks to one directory named after its stem; the
-    // desktop app's WSL install script relies on that layout to find `t3`.
+    // desktop app's WSL install script relies on that layout to find `goat`.
     const stem = wslRuntimeArchiveStem(input.appVersion, input.targetArch);
     const topLevel = new Set(members.map((member) => member.split("/")[0]));
     if (topLevel.size !== 1 || !topLevel.has(stem)) {
@@ -3476,7 +3476,7 @@
         ),
       );
     }
-    const requiredMembers = [`${stem}/t3`, `${stem}/client`, `${stem}/node_modules`];
+    const requiredMembers = [`${stem}/goat`, `${stem}/client`, `${stem}/node_modules`];
     const missingMembers = requiredMembers.filter((member) => !members.includes(member));
     // node-pty can load a source build or the prebuild for the WSL target.
     const ptyCandidates = [
@@ -4152,7 +4152,7 @@
   ),
   wslRuntime: Flag.String("wsl-runtime").pipe(
     Flag.withDescription(
-      "Path to the Linux CLI release archive (t3-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: T3CODE_DESKTOP_WSL_RUNTIME).",
+      "Path to the Linux CLI release archive (goat-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: T3CODE_DESKTOP_WSL_RUNTIME).",
     ),
     Flag.optional,
   ),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/smoke-cli-archive.ts`

Real archive smoke launches goat; do not execute it in this leaf.

```diff
--- a/scripts/smoke-cli-archive.ts
+++ b/scripts/smoke-cli-archive.ts
@@ -75,7 +75,7 @@
   const platform = yield* HostProcess.Platform;
   const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
   const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
-  // Windows can keep t3.exe locked (EBUSY) for a moment after the server
+  // Windows can keep goat.exe locked (EBUSY) for a moment after the server
   // exits. A leftover scratch directory on a CI runner is harmless, so
   // cleanup retries briefly and never fails a smoke test that passed.
   yield* Effect.addFinalizer(() =>
@@ -107,7 +107,7 @@
     });
   }
   const contentDir = path.join(scratch, root);
-  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
+  const executable = path.join(contentDir, platform === "win32" ? "goat.exe" : "goat");
   for (const required of [executable, path.join(contentDir, "client/index.html")]) {
     if (!(yield* fs.exists(required))) {
       return yield* new CliArchiveSmokeError({
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/release.yml`

Checksums/upload find renamed archives; npm filters/publication unchanged and not authorized to run.

```diff
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -815,7 +815,7 @@
           set -euo pipefail
           cd release-assets
           shopt -s nullglob
-          archives=(t3-*.tar.gz t3-*.zip)
+          archives=(goat-*.tar.gz goat-*.zip)
           if [[ ${#archives[@]} -eq 0 ]]; then
             echo "No CLI archives were produced." >&2
             exit 1
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/release-desktop.yml`

Desktop job locates renamed Linux archive.

```diff
--- a/.github/workflows/release-desktop.yml
+++ b/.github/workflows/release-desktop.yml
@@ -435,7 +435,7 @@
           elif [[ "${{ inputs.platform }}" == "win" ]]; then
             # Embed the Linux CLI archive built by the same-arch Linux job as
             # the WSL runtime. Required for a working WSL backend on Windows.
-            args+=(--wsl-runtime "$GITHUB_WORKSPACE"/wsl-runtime/t3-*-linux-${{ inputs.arch }}.tar.gz)
+            args+=(--wsl-runtime "$GITHUB_WORKSPACE"/wsl-runtime/goat-*-linux-${{ inputs.arch }}.tar.gz)
             if has_all \
               "$AZURE_TENANT_ID" \
               "$AZURE_CLIENT_ID" \
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/scripts/cli.ts`

Build success help points at actual artifact; publishing t3 tarballs remains unchanged.

```diff
--- a/apps/server/scripts/cli.ts
+++ b/apps/server/scripts/cli.ts
@@ -153,7 +153,7 @@
         return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
       }
       yield* Effect.log(
-        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
+        "[cli] Built dist-exe/goat (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
       );
     }),
 ).pipe(
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/invocation.ts`

Prefer proven goat global bin for new manifests; legacy t3-only manifests/native entries still classify, npm runner suggestions remain npx/pnpm/bunx t3.

```diff
--- a/apps/server/src/cli/invocation.ts
+++ b/apps/server/src/cli/invocation.ts
@@ -22,7 +22,7 @@
  *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
  *
  * Global installs and repo checkouts match none of these and return null.
- * Detection is best-effort; callers must fail closed to a plain `t3` command.
+ * Detection is best-effort; callers must fail closed to a plain `goat` command.
  */
 function detectCliRunner(entryPath: string): CliRunner | null {
   const path = entryPath.replaceAll("\\", "/");
@@ -45,7 +45,7 @@
 const InstallManifest = Schema.Struct({
   name: Schema.String,
   version: Schema.String,
-  bin: Schema.optionalKey(Schema.Struct({ t3: Schema.String })),
+  bin: Schema.optionalKey(Schema.Struct({ goat: Schema.optionalKey(Schema.String), t3: Schema.String })),
   optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
 });
 const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));
@@ -60,7 +60,7 @@
   const platform = yield* HostProcess.Platform;
   const entry = yield* fs.realPath(executable ? executablePath : (args[1] ?? ""));
   const match =
-    /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@t3code\/t3-[^/]+\/t3)$/.exec(
+    /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@t3code\/t3-[^/]+\/(?:goat|t3))$/.exec(
       entry,
     );
   if (!match) {
@@ -85,15 +85,17 @@
     .readFileString(path.join(packageRoot, "package.json"))
     .pipe(Effect.flatMap(decodeInstallManifest));
   if (manifest.name !== "t3" || !manifest.bin) return null;
-  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin.t3));
-  const globalBin = yield* fs.realPath(path.join(prefix, "bin/t3"));
+  const binName = manifest.bin.goat === undefined ? "t3" : "goat";
+  const binScript = manifest.bin.goat ?? manifest.bin.t3;
+  const bin = yield* fs.realPath(path.join(packageRoot, binScript));
+  const globalBin = yield* fs.realPath(path.join(prefix, "bin", binName));
   if (globalBin !== bin) return null;
   if (executable) {
     const nativeManifest = yield* fs
       .readFileString(path.join(path.dirname(entry), "package.json"))
       .pipe(Effect.flatMap(decodeInstallManifest));
     if (
-      manifest.bin.t3 !== "./bin/t3.js" ||
+      binScript !== "./bin/t3.js" ||
       manifest.optionalDependencies?.[nativeManifest.name] !== nativeManifest.version ||
       nativeManifest.version !== manifest.version
     )
@@ -116,9 +118,9 @@
 }

 /**
- * Render a `t3 <subcommand>` suggestion that matches how this process was
+ * Render a `goat <subcommand>` suggestion that matches how this process was
  * launched, so copy/pasting it actually works: `npx t3 connect` suggests
- * `npx t3 serve`, a global install suggests `t3 serve`, and a nightly build
+ * `npx t3 serve`, a global install suggests `goat serve`, and a nightly build
  * keeps the `@nightly` tag.
  */
 export function formatCliCommand(input: {
@@ -128,7 +130,7 @@
 }): string {
   const runner = detectCliRunner(input.entryPath);
   if (runner === null) {
-    return `t3 ${input.subcommand}`;
+    return `goat ${input.subcommand}`;
   }
   return `${runner} ${suggestedPackageSpec(input.version)} ${input.subcommand}`;
 }
@@ -148,10 +150,10 @@
   /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

 /**
- * The launcher a person can type to run this install when `t3` is not on
- * PATH: the desktop app's `t3` shim, which the app and the shim itself name in
+ * The launcher a person can type to run this install when `goat` is not on
+ * PATH: the desktop app's `goat` shim, which the app and the shim itself name in
  * `T3CODE_CLI_PATH`, or a standalone binary's own path. Script installs (a
- * repo checkout) have no single launcher and keep plain `t3`.
+ * repo checkout) have no single launcher and keep plain `goat`.
  */
 const resolveInstallLauncher = Effect.gen(function* () {
   const fs = yield* FileSystem.FileSystem;
@@ -165,15 +167,15 @@
 });

 /**
- * `t3 <subcommand>` for a person to run on this host: `t3` when it is on PATH,
+ * `goat <subcommand>` for a person to run on this host: `goat` when it is on PATH,
  * the package runner this process came from, or else the absolute path of the
  * launcher for this install, such as the one the desktop app installs.
  */
 const resolveHostCliCommand = (subcommand: string) =>
   Effect.gen(function* () {
     const command = yield* resolveCliCommand(subcommand);
-    if (command !== `t3 ${subcommand}`) return { command, launcher: false };
-    if (yield* isCommandAvailable("t3")) return { command, launcher: false };
+    if (command !== `goat ${subcommand}`) return { command, launcher: false };
+    if (yield* isCommandAvailable("goat")) return { command, launcher: false };
     const launcher = yield* resolveInstallLauncher;
     return Option.isSome(launcher)
       ? { command: `${shellWord(launcher.value)} ${subcommand}`, launcher: true }
@@ -181,9 +183,9 @@
   });

 /**
- * `t3 <subcommand>` as root, for setup a person runs once on the host. `sudo`
+ * `goat <subcommand>` as root, for setup a person runs once on the host. `sudo`
  * resets PATH on most distributions, which drops a user-installed Node (nvm,
- * fnm, a tarball) and with it `npx` or a global `t3`, so the command carries
+ * fnm, a tarball) and with it `npx` or a global `goat`, so the command carries
  * PATH through unless Node is on root's PATH too. An absolute launcher needs
  * neither.
  */
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/binCli.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/binCli.ts
+++ b/apps/server/src/binCli.ts
@@ -47,7 +47,7 @@
   Command.withHandler(() =>
     Effect.fail(
       new CliError.ShowHelp({
-        commandPath: ["t3", "connect"],
+        commandPath: ["goat", "connect"],
         errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
       }),
     ),
@@ -55,14 +55,14 @@
 );

 export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
-  Command.make("t3", { ...sharedServerCommandFlags }).pipe(
-    Command.withDescription("Run the T3 Code server."),
+  Command.make("goat", { ...sharedServerCommandFlags }).pipe(
+    Command.withDescription("Run the GOAT server."),
     Command.withHandler(runDefaultServerCommand),
     Command.withSubcommands([
       Command.make("help").pipe(
         Command.withDescription("Show command help."),
         Command.withHandler(() =>
-          Effect.fail(new CliError.ShowHelp({ commandPath: ["t3"], errors: [] })),
+          Effect.fail(new CliError.ShowHelp({ commandPath: ["goat"], errors: [] })),
         ),
       ),
       acpMcpBridgeCommand,
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/service.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/service.ts
+++ b/apps/server/src/cli/service.ts
@@ -71,7 +71,7 @@
     return "T3 Code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, macOS with launchd";
   }
   if (!status.installed) {
-    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
+    return "T3 Code service\n  Status: not installed\n  Next: Run `goat service install`.";
   }
   const installedVersion = status.installedVersion ?? cliVersion;
   const problems = (status.problems ?? []).map(
@@ -84,20 +84,20 @@
   ) {
     return [
       "T3 Code service",
-      `  Status: installed · t3@${installedVersion} (newer than this t3@${cliVersion} CLI)`,
+      `  Status: installed · goat@${installedVersion} (newer than this goat@${cliVersion} CLI)`,
       `  Unit: ${status.unitPath}`,
       `  Logs: ${status.logPath}`,
       ...problems,
-      `  Next: Run \`t3 update ${installedVersion}\` to match it, or pass \`--allow-downgrade\` to \`t3 service install\` explicitly.`,
+      `  Next: Run \`goat update ${installedVersion}\` to match it, or pass \`--allow-downgrade\` to \`goat service install\` explicitly.`,
     ].join("\n");
   }
   return [
     "T3 Code service",
-    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
+    `  Status: ${status.current ? `installed · goat@${installedVersion}` : "needs an update or repair"}`,
     `  Unit: ${status.unitPath}`,
     `  Logs: ${status.logPath}`,
     ...problems,
-    ...(status.current ? [] : ["  Next: Run `t3 service install` to repair it."]),
+    ...(status.current ? [] : ["  Next: Run `goat service install` to repair it."]),
   ].join("\n");
 }

@@ -127,37 +127,37 @@
         const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
         if (!result.changed) {
           yield* Console.log(
-            `T3 Code service is already installed with t3@${packageJson.version}.`,
+            `T3 Code service is already installed with goat@${packageJson.version}.`,
           );
           return;
         }
         yield* Console.log(
-          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
-        );
-      }),
-    ),
-  ),
-);
-
-// Kept one release for muscle memory and old docs. It did what `t3 service
-// install` does; the way to move to a newer release is `t3 update`.
+          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with goat@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
+        );
+      }),
+    ),
+  ),
+);
+
+// Kept one release for muscle memory and old docs. It did what `goat service
+// install` does; the way to move to a newer release is `goat update`.
 const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
-  Command.withDescription("Deprecated. Run `t3 update` to move to a newer release."),
+  Command.withDescription("Deprecated. Run `goat update` to move to a newer release."),
   Command.unlisted,
   Command.withHandler((flags) =>
     runServiceCommand(
       flags,
       Effect.gen(function* () {
         yield* Console.log(
-          "`t3 service update` is deprecated: run `t3 update` to move to a newer release, or `t3 service install` to repair the service. Repairing now.",
+          "`goat service update` is deprecated: run `goat update` to move to a newer release, or `goat service install` to repair the service. Repairing now.",
         );
         const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
         if (!result.changed) {
-          yield* Console.log(`T3 Code service is already using t3@${packageJson.version}.`);
+          yield* Console.log(`T3 Code service is already using goat@${packageJson.version}.`);
           return;
         }
         yield* Console.log(
-          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
+          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with goat@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
         );
       }),
     ),
@@ -166,7 +166,7 @@

 const serviceRestartCommand = Command.make("restart", projectLocationFlags).pipe(
   Command.withDescription(
-    "Restart the background service. Picks up a version installed by `t3 update` that was not restarted at the time.",
+    "Restart the background service. Picks up a version installed by `goat update` that was not restarted at the time.",
   ),
   Command.withHandler((flags) =>
     runServiceCommand(
@@ -177,7 +177,7 @@
         const restarted = yield* service.restart;
         yield* Console.log(
           restarted
-            ? `Restarted the T3 Code service${status.installedVersion === undefined ? "" : ` on t3@${status.installedVersion}`}.`
+            ? `Restarted the T3 Code service${status.installedVersion === undefined ? "" : ` on goat@${status.installedVersion}`}.`
             : "T3 Code service is not installed.",
         );
       }),
@@ -234,7 +234,7 @@
     compareExactServiceVersions(status.installedVersion, packageJson.version) > 0
   ) {
     yield* Console.log(
-      `A newer t3@${status.installedVersion} background service is installed. Leaving it unchanged.`,
+      `A newer goat@${status.installedVersion} background service is installed. Leaving it unchanged.`,
     );
     // This CLI cannot verify the newer service. Keep the manual fallback available.
     return false;
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/pair.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/pair.ts
+++ b/apps/server/src/cli/pair.ts
@@ -1,5 +1,5 @@
 /**
- * `t3 pair` - mint a pairing token for an already-running server and print it
+ * `goat pair` - mint a pairing token for an already-running server and print it
  * as a QR code, without restarting anything.
  *
  * Discovery reads the `server-runtime.json` a live server persists next to its
@@ -200,7 +200,7 @@
 type EnvironmentProbeResult =
   | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
   | { readonly _tag: "unreachable" }
-  | { readonly _tag: "not-a-t3-server" };
+  | { readonly _tag: "not-a-goat-server" };

 const probeEnvironmentDescriptor = (
   baseUrl: string,
@@ -215,7 +215,7 @@
     );
     // Bad-gateway family means a proxy (Tailscale Serve) answered for a
     // backend that is gone — a stale mapping, not a live occupant. Treating
-    // it as unreachable lets `t3 pair --tailscale` repair its own mapping
+    // it as unreachable lets `goat pair --tailscale` repair its own mapping
     // after the server's port changed.
     if (response.status === 502 || response.status === 503 || response.status === 504) {
       return { _tag: "unreachable" } as const;
@@ -224,7 +224,7 @@
     // some other service.
     const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
       Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
-      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
+      Effect.mapError(() => ({ _tag: "not-a-goat-server" }) as const),
     );
     return { _tag: "descriptor", descriptor } as const;
   }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));
@@ -244,7 +244,7 @@
     bases.push(yield* resolveBaseDir(explicitBaseDir));
   } else {
     // Same precedence as dev-runner: inside a linked worktree its own `.t3`
-    // outranks the shared home, so `t3 pair` in a worktree pairs with the dev
+    // outranks the shared home, so `goat pair` in a worktree pairs with the dev
     // server under test rather than the daily-driver install.
     const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
     if (worktreeHome !== undefined) {
@@ -391,7 +391,7 @@
         return { baseUrl, notes };
       }
     }
-    if (existing._tag === "not-a-t3-server") {
+    if (existing._tag === "not-a-goat-server") {
       return yield* new ServePortOccupiedError({ servePort: input.servePort });
     }

@@ -437,7 +437,7 @@
     return yield* environmentAuth.createPairingLink({
       scopes: input.scopes,
       subject: "one-time-token",
-      label: Option.getOrElse(input.label, () => "t3 pair"),
+      label: Option.getOrElse(input.label, () => "goat pair"),
       ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
     });
   }).pipe(
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/connect.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/connect.ts
+++ b/apps/server/src/cli/connect.ts
@@ -182,9 +182,9 @@
       ? "pending server startup"
       : "not provisioned";
   const nextStep = !status.authenticated
-    ? "Run `t3 connect link` to authorize and enable T3 Connect."
+    ? "Run `goat connect link` to authorize and enable T3 Connect."
     : !status.desired
-      ? "Run `t3 connect link` to enable T3 Connect."
+      ? "Run `goat connect link` to enable T3 Connect."
       : !status.linked
         ? "Start T3 to provision the environment link and launch its managed tunnel."
         : undefined;
@@ -198,7 +198,7 @@
     `  Publish agent activity: ${status.publishAgentActivity ? "enabled" : "disabled"}`,
     ...formatRelayClientStatus(status.relayClient),
     "",
-    "This is saved setup, not a live connection check. Check the background service with `t3 service status`.",
+    "This is saved setup, not a live connection check. Check the background service with `goat service status`.",
     ...(nextStep ? ["", `Next: ${nextStep}`] : []),
   ].join("\n");
 }
@@ -265,7 +265,7 @@
     environmentAuth.issueSession({
       scopes: [AuthRelayWriteScope],
       subject: "cloud-cli",
-      label: "t3 connect cli",
+      label: "goat connect cli",
     }),
     (issued) => run(issued.token),
     (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
@@ -374,7 +374,7 @@
       yield* Console.warn(
         input.clearAuthorization
           ? "Could not revoke the relay-side environment record before signing out.\nThe stored CLI authorization was still removed locally."
-          : "Could not revoke the relay-side environment record yet.\nRun `t3 connect unlink` again when the relay is reachable.",
+          : "Could not revoke the relay-side environment record yet.\nRun `goat connect unlink` again when the relay is reachable.",
       );
     } else if (input.relayResult.value.status === "revoked") {
       yield* Console.log("Revoked the relay-side environment record.");
@@ -403,7 +403,7 @@

   if (options.clearAuthorization) {
     yield* Console.log(
-      "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
+      "Signed out of T3 Connect locally.\nThe background service is managed separately with `goat service`.",
     );
   }
 });
@@ -622,11 +622,11 @@
         // out of band without T3 Connect.
         if (!(yield* tokens.hasCredential)) {
           yield* Console.log(
-            "Run `t3 connect login` first so this environment can be authorized to publish.",
+            "Run `goat connect login` first so this environment can be authorized to publish.",
           );
           return;
         }
-        // A link may already be desired (e.g. `t3 connect link` before the
+        // A link may already be desired (e.g. `goat connect link` before the
         // server's first start). Never downgrade it: a desired managed link
         // also covers publishing, so only request a publish-only link when no
         // link is pending at all.
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/app.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/app.ts
+++ b/apps/server/src/cli/app.ts
@@ -32,7 +32,7 @@
   {},
 ) {
   override get message(): string {
-    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.";
+    return "`goat app` only controls a desktop app on the same machine. It cannot run over SSH.";
   }
 }

@@ -41,7 +41,7 @@
   { platform: Schema.String },
 ) {
   override get message(): string {
-    return `\`t3 app\` is not supported on ${this.platform}.`;
+    return `\`goat app\` is not supported on ${this.platform}.`;
   }
 }

@@ -55,7 +55,7 @@
   },
 ) {
   override get message(): string {
-    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
+    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `goat app` again. A running T3 Code server is not enough.";
   }
 }

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/triage.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/triage.ts
+++ b/apps/server/src/cli/triage.ts
@@ -1,5 +1,5 @@
 /**
- * `t3 triage` - hand a misbehaving install to the user's own coding agent.
+ * `goat triage` - hand a misbehaving install to the user's own coding agent.
  *
  * The command is deliberately thin: it writes a `context.md` with machine facts
  * (version, paths, server liveness), then launches claude or codex
@@ -168,7 +168,7 @@

       // Triage is a user-facing feature: always the userdata state, never dev.
       // --base-dir wins; T3CODE_HOME is its documented env equivalent (same
-      // precedence as `t3 pair`).
+      // precedence as `goat pair`).
       const explicitBaseDir = Option.getOrUndefined(flags.baseDir);
       const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
       const baseDir = yield* resolveBaseDir(explicitBaseDir ?? Option.getOrUndefined(envHome));
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/triagePrompt.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/triagePrompt.ts
+++ b/apps/server/src/cli/triagePrompt.ts
@@ -1,5 +1,5 @@
 /**
- * All text `t3 triage` hands to the coding agent. Kept as bare template strings
+ * All text `goat triage` hands to the coding agent. Kept as bare template strings
  * on purpose: to change triage behavior, edit the text.
  *
  * `TRIAGE_PLAYBOOK` must stay byte-identical to `.github/triage/PLAYBOOK.md`
@@ -65,7 +65,7 @@

 - How is T3 Code running on this machine: \`npx t3 serve\` in a terminal, the
   background service, or the desktop app?
-- Which surface is the user connecting from: the website (app.t3.codes), the
+- Which surface is the user connecting from: the website (app.goat.codes), the
   desktop app against a local server, the desktop app against a remote server,
   or the mobile app?

@@ -151,7 +151,7 @@

 /** The full seed prompt, written to `prompt.md` in the triage scratch dir. */
 export const buildTriageSeedPrompt = (contextFilePath: string) => `A T3 Code user is \
-having a problem with their install and started this session with \`t3 triage\`.
+having a problem with their install and started this session with \`goat triage\`.

 Machine facts (version, OS, paths, server liveness) are in the triage context file:

@@ -191,7 +191,7 @@
 /** The `context.md` written into the triage scratch directory. */
 export const buildTriageContext = (input: TriageContextInput) => `# T3 Code triage context

-Generated by \`t3 triage\` at ${input.generatedAt}.
+Generated by \`goat triage\` at ${input.generatedAt}.

 - Installed version: ${input.version}
 - Release tag for this version: ${input.releaseTag}
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/uninstall.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/uninstall.ts
+++ b/apps/server/src/cli/uninstall.ts
@@ -29,15 +29,15 @@
 }

 /**
- * What `t3 uninstall` would remove for one T3 home. Computed before anything
+ * What `goat uninstall` would remove for one T3 home. Computed before anything
  * is touched so the user sees the whole plan in one place.
  */
 export interface UninstallPlan {
   /** The background service serves this home and will be stopped and removed. */
   readonly service: boolean;
-  /** The `t3` launcher (symlink or `.cmd` shim) that points into this home's runtime tree. */
+  /** The `goat` launcher (symlink or `.cmd` shim) that points into this home's runtime tree. */
   readonly launcher: string | undefined;
-  /** `<home>/runtime`, holding every downloaded version, when it exists. */
+  /** `<home>/runtime/goat`, holding every downloaded version, when it exists. */
   readonly runtimeDir: string | undefined;
   /** `<home>/userdata`, which is never removed; shown so the user knows where it is. */
   readonly userdataDir: string;
@@ -45,7 +45,7 @@

 /**
  * Finds the launcher this install left on PATH. Only a launcher that points
- * into this home's `runtime/versions` is claimed: a plain copy of the
+ * into this home's `runtime/goat/versions` is claimed: a plain copy of the
  * executable, or a launcher for another home, is not ours to delete.
  */
 export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
@@ -106,7 +106,7 @@
   ),
 }).pipe(
   Command.withDescription(
-    "Remove t3 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
+    "Remove goat from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
   ),
   Command.withHandler((flags) =>
     Effect.gen(function* () {
@@ -130,10 +130,10 @@
   const plan = yield* planUninstall({ baseDir: input.baseDir });

   if (!plan.service && plan.launcher === undefined && plan.runtimeDir === undefined) {
-    yield* Console.log(`Nothing to remove: t3 is not installed for ${input.baseDir}.`);
+    yield* Console.log(`Nothing to remove: goat is not installed for ${input.baseDir}.`);
     if (!(yield* HostProcess.IsExecutable)) {
       yield* Console.log(
-        "  This t3 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
+        "  This goat runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
       );
     }
     return;
@@ -157,7 +157,7 @@
       });
     }
     const confirmed = yield* Prompt.run(
-      Prompt.Confirm({ message: "Remove t3 from this machine?", initial: false }),
+      Prompt.Confirm({ message: "Remove goat from this machine?", initial: false }),
     ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
     if (!confirmed) {
       yield* Console.log("Left as is.");
@@ -201,7 +201,7 @@
             reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
           }),
       });
-      yield* Console.log(`${runtimeDir} will be removed once t3 exits.`);
+      yield* Console.log(`${runtimeDir} will be removed once goat exits.`);
     } else {
       yield* fs
         .remove(plan.runtimeDir, { recursive: true, force: true })
@@ -214,5 +214,5 @@
     }
   }
   yield* Console.log("");
-  yield* Console.log("t3 is uninstalled. Thanks for trying T3 Code.");
+  yield* Console.log("goat is uninstalled. Thanks for trying T3 Code.");
 });
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/browser.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/browser.ts
+++ b/apps/server/src/cli/browser.ts
@@ -1,5 +1,5 @@
 /**
- * `t3 browser setup` - prepares a Linux host for T3's headless browser, which
+ * `goat browser setup` - prepares a Linux host for T3's headless browser, which
  * server browser tabs and HTML render previews share. It is the fix every
  * browser host error names, so it does the whole job in one run:
  *
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/trace.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/trace.ts
+++ b/apps/server/src/cli/trace.ts
@@ -1,5 +1,5 @@
 /**
- * `t3 trace summary` - per-span counts, rates, and latency percentiles from
+ * `goat trace summary` - per-span counts, rates, and latency percentiles from
  * the local server trace file and its rotated backups. It reads the files
  * directly, so it works while the server is stalled or stopped.
  */
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/config.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/config.ts
+++ b/apps/server/src/cli/config.ts
@@ -84,7 +84,7 @@
   Flag.optional,
 );

-// Trace file location, shared by the server and `t3 trace summary`.
+// Trace file location, shared by the server and `goat trace summary`.
 export const traceFileConfig = Config.String("T3CODE_TRACE_FILE").pipe(
   Config.option,
   Config.map(Option.getOrUndefined),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/bin.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/bin.ts
+++ b/apps/server/src/bin.ts
@@ -1,8 +1,8 @@
 /**
  * Thin CLI entry.
  *
- * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
- * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
+ * Every ACP agent spawns `goat acp-mcp-bridge` while opening its session, and
+ * terminal-fallback agents run `goat acp-mcp-call` per tool call, so their
  * startup sits on first-message latency. Both dispatch here before the full
  * CLI module graph (seconds of evaluation) loads; everything else defers to
  * the real CLI in ./binCli.ts.
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/update.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cli/update.ts
+++ b/apps/server/src/cli/update.ts
@@ -69,16 +69,16 @@
       .pipe(
         Effect.flatMap(HttpClientResponse.filterStatusOk),
         Effect.flatMap((response) => response.text),
-        Effect.mapError(() => new CliUpdateError({ reason: "Could not list t3 releases." })),
+        Effect.mapError(() => new CliUpdateError({ reason: "Could not list goat releases." })),
         Effect.timeoutOrElse({
           duration: RELEASE_INDEX_TIMEOUT,
           orElse: () =>
-            Effect.fail(new CliUpdateError({ reason: "Timed out listing t3 releases." })),
+            Effect.fail(new CliUpdateError({ reason: "Timed out listing goat releases." })),
         }),
       );
     const releases = yield* decodeReleaseIndex(body).pipe(
       Effect.mapError(
-        () => new CliUpdateError({ reason: "The t3 release index had an unexpected shape." }),
+        () => new CliUpdateError({ reason: "The goat release index had an unexpected shape." }),
       ),
     );
     const version = newestCliReleaseVersion(releases, channel);
@@ -88,7 +88,7 @@
   return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
 });

-/** Whether a launcher target lives inside `<baseDir>/runtime/versions`. */
+/** Whether a launcher target lives inside `<baseDir>/runtime/goat/versions`. */
 export function launcherOwnsVersionsDir(
   path: Path.Path,
   versionsDir: string,
@@ -99,16 +99,16 @@
 }

 /**
- * The launcher the install scripts leave behind: a symlink at `<bin>/t3` on
- * POSIX, a `t3.cmd` shim on Windows. `t3 update` repoints it so the next `t3`
+ * The launcher the install scripts leave behind: a symlink at `<bin>/goat` on
+ * POSIX, a `goat.cmd` shim on Windows. `goat update` repoints it so the next `goat`
  * invocation is the new version. Only a launcher that already points into
- * this home's `runtime/versions` tree is touched; a plain copy of the
+ * this home's `runtime/goat/versions` tree is touched; a plain copy of the
  * executable, or a launcher for some other install, is left alone.
  */
 export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
   /** Path the current process was started through, if known. */
   readonly launchedAs: string | undefined;
-  /** `<baseDir>/runtime/versions` of the home being updated. */
+  /** `<baseDir>/runtime/goat/versions` of the home being updated. */
   readonly versionsDir: string;
   readonly targetEntryPath: string;
 }) {
@@ -121,9 +121,9 @@

   if (platform === "win32") {
     // The shim runs the executable by absolute path, so the executable sees
-    // itself as argv0; the shim is the `t3.cmd` next to it only when launched
+    // itself as argv0; the shim is the `goat.cmd` next to it only when launched
     // from an install script's bin directory. Find it by searching the
-    // directories that would resolve `t3` on this shell's PATH.
+    // directories that would resolve `goat` on this shell's PATH.
     const shimPath = yield* findWindowsShim(input.launchedAs);
     if (shimPath === undefined) return Option.none<string>();
     const current = yield* fs.readFileString(shimPath).pipe(Effect.option);
@@ -133,7 +133,7 @@
       .writeFileString(shimPath, `@echo off\r\n"${input.targetEntryPath}" %*`)
       .pipe(
         Effect.mapError(
-          () => new CliUpdateError({ reason: `Could not rewrite the t3 launcher at ${shimPath}.` }),
+          () => new CliUpdateError({ reason: `Could not rewrite the goat launcher at ${shimPath}.` }),
         ),
       );
     return Option.some(shimPath);
@@ -148,7 +148,7 @@
     Effect.andThen(fs.rename(tempLink, input.launchedAs)),
     Effect.mapError(
       () =>
-        new CliUpdateError({ reason: `Could not repoint the t3 launcher at ${input.launchedAs}.` }),
+        new CliUpdateError({ reason: `Could not repoint the goat launcher at ${input.launchedAs}.` }),
     ),
   );
   return Option.some(input.launchedAs);
@@ -156,8 +156,8 @@

 /**
  * The path the executable was started through. Node keeps the shell's
- * spelling in argv0: a launcher symlink or `./t3` resolves against the
- * working directory, while a bare `t3` was found on PATH and has to be
+ * spelling in argv0: a launcher symlink or `./goat` resolves against the
+ * working directory, while a bare `goat` was found on PATH and has to be
  * looked up there again, or the launcher symlink is never seen.
  */
 export const resolveLauncherPath = Effect.gen(function* () {
@@ -183,7 +183,7 @@

 /**
  * On Windows a `.cmd` shim is what PATH resolves, but the executable it runs
- * only ever sees its own path. Walk PATH for a `t3.cmd` whose target is the
+ * only ever sees its own path. Walk PATH for a `goat.cmd` whose target is the
  * running executable; that is the launcher the install script wrote.
  */
 export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
@@ -197,7 +197,7 @@
     ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
   ].filter((entry) => entry.trim().length > 0);
   for (const directory of candidates) {
-    const shimPath = path.join(directory, "t3.cmd");
+    const shimPath = path.join(directory, "goat.cmd");
     const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
     if (Option.isNone(contents)) continue;
     const target = /^"([^"]+)"/m.exec(contents.value)?.[1];
@@ -215,7 +215,7 @@
   ...projectLocationFlags,
   channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
     Flag.withDescription(
-      "Release channel to follow. Defaults to the channel this t3 was published on.",
+      "Release channel to follow. Defaults to the channel this goat was published on.",
     ),
     Flag.optional,
   ),
@@ -244,7 +244,7 @@
   version: versionArgument,
 }).pipe(
   Command.withDescription(
-    "Download a newer t3 and switch this machine to it, including the background service when one is installed.",
+    "Download a newer goat and switch this machine to it, including the background service when one is installed.",
   ),
   Command.withHandler((flags) =>
     Effect.gen(function* () {
@@ -268,7 +268,7 @@
 );

 /**
- * A `t3 serve` or `t3` someone started by hand, as opposed to the one the
+ * A `goat serve` or `goat` someone started by hand, as opposed to the one the
  * background service supervises. The server records its pid on startup; a
  * stale file from a crashed server is ignored by checking the pid is alive.
  *
@@ -343,7 +343,7 @@
   const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
   if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
     return yield* new CliUpdateError({
-      reason: `'${input.requestedVersion}' is not an exact t3 version.`,
+      reason: `'${input.requestedVersion}' is not an exact goat version.`,
     });
   }
   const progress = createUpdateProgress();
@@ -363,10 +363,10 @@
   if (targetChannel === "preview" && currentChannel !== "preview") {
     yield* Console.log(
       [
-        `t3@${targetVersion} is a preview build.`,
+        `goat@${targetVersion} is a preview build.`,
         "  Preview builds are cut by maintainers from unreleased branches to exercise the release",
         "  pipeline. They can be broken, receive no fixes, and are never offered as updates; you",
-        `  will have to switch back to ${currentChannel} yourself with \`t3 update --channel ${currentChannel} --allow-downgrade\`.`,
+        `  will have to switch back to ${currentChannel} yourself with \`goat update --channel ${currentChannel} --allow-downgrade\`.`,
       ].join("\n"),
     );
     if (!(process.stdin.isTTY && process.stdout.isTTY)) {
@@ -423,14 +423,14 @@
   if (executableCurrent && serviceCurrent) {
     yield* Console.log(
       serviceVersion !== undefined
-        ? `t3 and its background service are already on ${targetVersion} (${targetChannel}).`
-        : `t3 is already on ${targetVersion} (${targetChannel}).`,
+        ? `goat and its background service are already on ${targetVersion} (${targetChannel}).`
+        : `goat is already on ${targetVersion} (${targetChannel}).`,
     );
     return;
   }
   if (!input.allowDowngrade && compareExactServiceVersions(targetVersion, newestInstalled) < 0) {
     return yield* new CliUpdateError({
-      reason: `t3@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
+      reason: `goat@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
     });
   }

@@ -469,7 +469,7 @@
       ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
     } else {
       yield* Console.log(
-        "  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run `t3 service restart` later.",
+        "  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run `goat service restart` later.",
       );
     }
   }
@@ -495,14 +495,14 @@
         .pipe(
           Effect.mapError(
             (cause) =>
-              new PinnedRuntimeInstallError({ step: "verifying the downloaded t3", cause }),
+              new PinnedRuntimeInstallError({ step: "verifying the downloaded goat", cause }),
           ),
           Effect.flatMap((result) =>
             result.code === 0 && /\bv(\S+)\s*$/.exec(result.stdout)?.[1] === targetVersion
               ? Effect.void
               : Effect.fail(
                   new PinnedRuntimeInstallError({
-                    step: "verifying the downloaded t3",
+                    step: "verifying the downloaded goat",
                     exitCode: Number(result.code),
                   }),
                 ),
@@ -513,12 +513,12 @@
     Effect.catchIf(
       (error): error is PinnedRuntimeInstallError =>
         error._tag === "PinnedRuntimeInstallError" &&
-        error.step.startsWith("downloading the t3 release checksums") &&
+        error.step.startsWith("downloading the GOAT release checksums") &&
         String(error.cause).includes("404"),
       () =>
         Effect.fail(
           new CliUpdateError({
-            reason: `No release archive was published for t3@${targetVersion}.`,
+            reason: `No release archive was published for goat@${targetVersion}.`,
           }),
         ),
     ),
@@ -535,7 +535,7 @@
   // downloaded runtime has already proven it runs (the `--version` check
   // above), and doing it here rather than through the target's own CLI means
   // a downgrade to a version without today's commands still works. The unit
-  // is rewritten either way so a later `t3 service restart` lands on the new
+  // is rewritten either way so a later `goat service restart` lands on the new
   // version; only the restart itself waits for the user's answer.
   let serviceUpdated = false;
   if (serviceInstalled && !serviceCurrent) {
@@ -558,7 +558,7 @@
       Effect.mapError(
         (error) =>
           new CliUpdateError({
-            reason: `t3@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
+            reason: `goat@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
           }),
       ),
     );
@@ -567,7 +567,7 @@

   progress.success(`Installed T3 Code ${targetVersion}`);
   if (Option.isSome(repointed)) {
-    yield* Console.log("  Run t3 to get started.\n");
+    yield* Console.log("  Run goat to get started.\n");
   } else {
     yield* Console.log(`  Run ${runtime.entryPath}\n`);
   }
@@ -577,7 +577,7 @@
     yield* Console.log(`  Background service already on ${targetVersion}`);
   } else if (serviceInstalled) {
     yield* Console.log(
-      `  Background service still running ${serviceVersion ?? "an unknown version"}. Run \`t3 service restart\` when you are ready to switch it to ${targetVersion}.`,
+      `  Background service still running ${serviceVersion ?? "an unknown version"}. Run \`goat service restart\` when you are ready to switch it to ${targetVersion}.`,
     );
   } else if (status.installed && !servesThisHome) {
     yield* Console.log(
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/CloudLink.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cloud/CloudLink.ts
+++ b/apps/server/src/cloud/CloudLink.ts
@@ -192,13 +192,13 @@
   }
 }

-/** Linking from the CLI needs the authorization `t3 connect link` stores. */
+/** Linking from the CLI needs the authorization `goat connect link` stores. */
 export class CloudLinkAuthorizationMissingError extends Schema.TaggedError<CloudLinkAuthorizationMissingError>()(
   "CloudLinkAuthorizationMissingError",
   {},
 ) {
   override get message(): string {
-    return "Run `t3 connect link` to authorize this environment.";
+    return "Run `goat connect link` to authorize this environment.";
   }
 }

@@ -563,7 +563,7 @@
       | HttpClientError.HttpClientError
     >;
   }
->()("t3/cloud/CloudLink") {}
+>()("goat/cloud/CloudLink") {}

 const make = Effect.gen(function* () {
   const secrets = yield* ServerSecretStore.ServerSecretStore;
@@ -644,7 +644,7 @@
     const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
     const descriptor = yield* environment.getDescriptor;
     const payload = {
-      iss: `t3-env:${descriptor.environmentId}`,
+      iss: `goat-env:${descriptor.environmentId}`,
       aud: normalizeRelayIssuer(request.relayIssuer),
       sub: descriptor.environmentId,
       jti: yield* crypto.randomUUIDv4,
@@ -979,7 +979,7 @@
     const now = yield* DateTime.now;
     const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
     const claims = {
-      iss: `t3-env:${input.environmentId}`,
+      iss: `goat-env:${input.environmentId}`,
       aud: normalizeRelayIssuer(
         Option.isSome(configuredIssuer) ? bytesToString(configuredIssuer.value) : input.relayUrl,
       ),
@@ -1485,7 +1485,7 @@
         token: request.proof,
         typ: RELAY_HEALTH_REQUEST_TYP,
         issuer: normalizeRelayIssuer(relayIssuer),
-        audience: `t3-env:${environmentId}`,
+        audience: `goat-env:${environmentId}`,
         nowEpochSeconds: nowSeconds,
       }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
       if (
@@ -1514,7 +1514,7 @@
       const descriptor = yield* environment.getDescriptor;
       const responseExpiresAt = DateTime.add(now, { minutes: 5 });
       const responsePayload = {
-        iss: `t3-env:${environmentId}`,
+        iss: `goat-env:${environmentId}`,
         aud: normalizeRelayIssuer(relayIssuer),
         sub: environmentId,
         jti: yield* crypto.randomUUIDv4,
@@ -1589,7 +1589,7 @@
         token: request.proof,
         typ: RELAY_MINT_REQUEST_TYP,
         issuer: normalizeRelayIssuer(relayIssuer),
-        audience: `t3-env:${environmentId}`,
+        audience: `goat-env:${environmentId}`,
         nowEpochSeconds: nowSeconds,
       }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
       if (
@@ -1624,7 +1624,7 @@
         proofKeyThumbprint: proof.clientProofKeyThumbprint,
       });
       const responsePayload = {
-        iss: `t3-env:${environmentId}`,
+        iss: `goat-env:${environmentId}`,
         aud: normalizeRelayIssuer(relayIssuer),
         sub: environmentId,
         jti: yield* crypto.randomUUIDv4,
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/relayResponse.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cloud/relayResponse.ts
+++ b/apps/server/src/cloud/relayResponse.ts
@@ -42,7 +42,7 @@
     case "RelayEnvironmentLinkLimitExceededError":
       return "Unlink an unused environment in T3 Connect, then restart T3 Code on this machine.";
     case "RelayAuthInvalidError":
-      return "Run `t3 connect login` to check this machine's authorization. If the stored credential was revoked, sign out with `t3 connect logout`, then run `t3 connect` again. Restart T3 Code after signing in.";
+      return "Run `goat connect login` to check this machine's authorization. If the stored credential was revoked, sign out with `goat connect logout`, then run `goat connect` again. Restart T3 Code after signing in.";
     case "RelayEnvironmentLinkProofExpiredError":
     case "RelayEnvironmentLinkProofInvalidError":
       return "Check this machine's date and time, update T3 Code, then restart it.";
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/selfUpdate.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cloud/selfUpdate.ts
+++ b/apps/server/src/cloud/selfUpdate.ts
@@ -60,7 +60,7 @@
       onHandoffAccepted?: () => Effect.Effect<void>,
     ) => Effect.Effect<never, ServerSelfUpdateError>;
   }
->()("t3/cloud/selfUpdate/ServerSelfUpdate") {}
+>()("goat/cloud/selfUpdate/ServerSelfUpdate") {}

 export const withRunningThreadContinuation = Effect.fn(
   "cloud.server_self_update.withRunningThreadContinuation",
@@ -209,13 +209,13 @@
     }
     if (capability === null) {
       return yield* failWith(
-        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
+        "Remote updates require the T3 Code background service. Run `goat service install` on the server machine.",
       );
     }

     const targetVersion = input.targetVersion.trim();
     if (!isExactServiceVersion(targetVersion)) {
-      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
+      return yield* failWith(`'${targetVersion}' is not an exact goat version.`);
     }
     if (yield* Ref.getAndSet(inFlight, true)) {
       return yield* failWith("A server update is already in progress.");
@@ -306,7 +306,7 @@
         Effect.mapError((error) =>
           error._tag === "PinnedRuntimePreflightBlockedError"
             ? failWith(error.reason, error)
-            : failWith(`Could not prepare t3@${targetVersion}.`, error),
+            : failWith(`Could not prepare goat@${targetVersion}.`, error),
         ),
       );

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/bootService.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/cloud/bootService.ts
+++ b/apps/server/src/cloud/bootService.ts
@@ -38,7 +38,7 @@
 const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
 const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
 const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
-/** File in the logs dir that receives the service's stdout and stderr. `t3 triage` points agents at it. */
+/** File in the logs dir that receives the service's stdout and stderr. `goat triage` points agents at it. */
 export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

 /** systemd expands `%` specifiers, including in unquoted append-log paths. */
@@ -465,11 +465,11 @@
     case "linger-disabled":
       return 'Lingering is disabled. T3 Code will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
     case "service-disabled":
-      return "The service is not enabled to start automatically. Run `t3 service install` to repair it.";
+      return "The service is not enabled to start automatically. Run `goat service install` to repair it.";
     case "service-stopped":
-      return "The service is not running. Check the service log and `systemctl --user status t3code.service`, then run `t3 service install`.";
+      return "The service is not running. Check the service log and `systemctl --user status t3code.service`, then run `goat service install`.";
     case "restart-pending":
-      return "A newer version is installed but the service is still running the previous one. Run `t3 service restart` to switch.";
+      return "A newer version is installed but the service is still running the previous one. Run `goat service restart` to switch.";
   }
 }

@@ -499,7 +499,7 @@
   },
 ) {
   override get message(): string {
-    return `Refusing to replace t3@${this.installedVersion} with older t3@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
+    return `Refusing to replace goat@${this.installedVersion} with older goat@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
   }
 }

@@ -519,7 +519,7 @@
   /**
    * The T3 home the installed unit serves. The unit name is fixed per user,
    * so a caller working against another base dir must not treat this service
-   * as its own; `t3 update --base-dir` learned that by restarting the live
+   * as its own; `goat update --base-dir` learned that by restarting the live
    * server of the machine it ran on.
    */
   readonly installedBaseDir?: string;
@@ -535,8 +535,8 @@
       readonly allowDowngrade?: boolean;
       /**
        * Write the unit for this version but leave the service on whatever it
-       * is running now. `t3 update` uses this when the user declines the
-       * restart, so a later `t3 service restart` lands on the new version.
+       * is running now. `goat update` uses this when the user declines the
+       * restart, so a later `goat service restart` lands on the new version.
        */
       readonly start?: boolean;
     }) => Effect.Effect<BootServicePlan, BootServiceError>;
@@ -550,7 +550,7 @@
     readonly uninstall: Effect.Effect<boolean, BootServiceError>;
     readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
   }
->()("t3/cloud/bootService") {}
+>()("goat/cloud/bootService") {}

 export interface BootServiceHost {
   readonly execPath: string;
@@ -786,7 +786,7 @@
             Effect.mapError(
               (cause) =>
                 new PinnedRuntimeInstallError({
-                  step: "verifying the pinned t3 runtime",
+                  step: "verifying the pinned goat runtime",
                   cause,
                 }),
             ),
@@ -796,7 +796,7 @@
                 ? Effect.void
                 : Effect.fail(
                     new PinnedRuntimeInstallError({
-                      step: "verifying the pinned t3 runtime",
+                      step: "verifying the pinned goat runtime",
                       exitCode: Number(result.code),
                       stdoutLength: result.stdout.length,
                       stderrLength: result.stderr.length,
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/preview/PreviewBrowserHost.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/apps/server/src/preview/PreviewBrowserHost.ts
+++ b/apps/server/src/preview/PreviewBrowserHost.ts
@@ -1,7 +1,7 @@
 /**
  * Host setup the shared headless browser needs, and the one command that does
  * it. Every failure here names that command, so the server log, an agent's tool
- * error, and the viewer all offer the same fix: `sudo t3 browser setup`.
+ * error, and the viewer all offer the same fix: `sudo goat browser setup`.
  *
  * T3 never turns Chrome's sandbox off by itself. A host that cannot give it one
  * gets the command instead, and only the operator's explicit
@@ -33,7 +33,7 @@
  * the user namespace Chrome's sandbox runs in. Modelled on the profile Ubuntu
  * ships for Google Chrome; `unconfined` adds nothing beyond `userns`.
  */
-export const APPARMOR_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
+export const APPARMOR_PROFILE = `# Written by \`goat browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
 abi <abi/4.0>,
 include <tunables/global>

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/HostProcess.ts`

CLI/help/error strings use goat; package runner/npm invocations and persisted identifiers stay unchanged.

```diff
--- a/packages/shared/src/HostProcess.ts
+++ b/packages/shared/src/HostProcess.ts
@@ -56,7 +56,7 @@

 /**
  * The command the shell was given, before Node resolved it to the binary:
- * `t3` for a PATH lookup, `./t3` or the launcher symlink for an explicit
+ * `goat` for a PATH lookup, `./goat` or the launcher symlink for an explicit
  * path. `process.argv[0]` and `execPath` are always the resolved binary.
  */
 export const InvokedAs = Context.Reference<string>("@t3tools/shared/HostProcess/InvokedAs", {
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/settings/CliCommandSettingsRow.tsx`

User command guidance/search on web/desktop/mobile; no wire-contract or layout change.

```diff
--- a/apps/web/src/components/settings/CliCommandSettingsRow.tsx
+++ b/apps/web/src/components/settings/CliCommandSettingsRow.tsx
@@ -7,7 +7,7 @@
 import { searchableSetting } from "./settingsSearch";

 /**
- * Settings → `t3` command: puts the desktop app's bundled CLI on PATH, or takes
+ * Settings → `goat` command: puts the desktop app's bundled CLI on PATH, or takes
  * it off again. Hidden where the desktop build has no launcher to install.
  */
 export function CliCommandSettingsRow() {
@@ -39,7 +39,7 @@
           toastManager.add(
             stackedThreadToast({
               type: "error",
-              title: action === "install" ? "Could not install t3" : "Could not remove t3",
+              title: action === "install" ? "Could not install goat" : "Could not remove goat",
               description: error instanceof Error ? error.message : "Something went wrong.",
             }),
           );
@@ -52,12 +52,12 @@
   if (!bridge || !state?.supported) return null;
   const installed = state.installedPath !== null;
   const description = state.shadowedBy
-    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use T3 Code's.`
+    ? `Another goat at ${state.shadowedBy} runs first in a new terminal. Remove it to use GOAT's.`
     : !installed
-      ? "Run T3 Code's CLI as `t3` from any terminal."
+      ? "Run GOAT's CLI as `goat` from any terminal."
       : state.onPath
         ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
-        : `Installed at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`t3\`.`;
+        : `Installed at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`goat\`.`;

   return (
     <SettingsRow
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/settings/settingsSearch.ts`

User command guidance/search on web/desktop/mobile; no wire-contract or layout change.

```diff
--- a/apps/web/src/components/settings/settingsSearch.ts
+++ b/apps/web/src/components/settings/settingsSearch.ts
@@ -539,9 +539,9 @@
   },
   {
     id: "cli-command",
-    title: "t3 command",
-    to: "/settings/general",
-    searchTerms: ["cli terminal shell path install command line"],
+    title: "goat command",
+    to: "/settings/general",
+    searchTerms: ["goat t3 cli terminal shell path install command line"],
     desktopOnly: true,
   },
   {
@@ -908,7 +908,7 @@
     title: "Hold webhooks while offline",
     to: "/settings/connections",
     targetId: "connections-environment",
-    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
+    searchTerms: ["webhook automations offline queue mailbox goat connect"],
     cloudOnly: true,
     managedTunnelOnly: true,
   },
@@ -933,7 +933,7 @@
     id: "remote-environments",
     title: "Environments",
     to: "/settings/connections",
-    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
+    searchTerms: ["add pair backend host code ssh config agent tunnel saved goat connect"],
   },
   {
     id: "load-balancing",
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/ServerUpdateAction.tsx`

User command guidance/search on web/desktop/mobile; no wire-contract or layout change.

```diff
--- a/apps/web/src/components/ServerUpdateAction.tsx
+++ b/apps/web/src/components/ServerUpdateAction.tsx
@@ -95,7 +95,7 @@
         description:
           selfUpdate === "desktop-managed"
             ? `Desktop app relaunched on ${result.value.targetVersion}.`
-            : `Reconnected on t3@${result.value.targetVersion}.`,
+            : `Reconnected on goat@${result.value.targetVersion}.`,
       });
     } catch (error) {
       toastManager.add({
@@ -238,8 +238,8 @@
           installation?.kind === "npm-global" ? "Update command copied" : "Relaunch command copied",
         description:
           installation?.kind === "npm-global"
-            ? `Run \`${command}\` on ${serverLabel}, then restart t3 with your usual options.`
-            : `Stop t3 on ${serverLabel}, then relaunch with \`${command}\` using the same subcommand and options. This does not update an installed t3 command.`,
+            ? `Run \`${command}\` on ${serverLabel}, then restart goat with your usual options.`
+            : `Stop goat on ${serverLabel}, then relaunch with \`${command}\` using the same subcommand and options. This does not update an installed goat command.`,
       });
     },
     onError: (error) => {
@@ -372,7 +372,7 @@
       toastManager.add({
         type: "success",
         title: `${serverLabel} updated`,
-        description: `Reconnected on t3@${result.value.targetVersion}.`,
+        description: `Reconnected on goat@${result.value.targetVersion}.`,
       });
     } catch (error) {
       toastManager.add({
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/cloud/ConnectCliAuthSurface.tsx`

User command guidance/search on web/desktop/mobile; no wire-contract or layout change.

```diff
--- a/apps/web/src/components/cloud/ConnectCliAuthSurface.tsx
+++ b/apps/web/src/components/cloud/ConnectCliAuthSurface.tsx
@@ -35,7 +35,7 @@
   eyebrow: "Authorization request",
   title: "This connect link is incomplete",
   description:
-    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
+    "The link is missing its authorization request. Re-run `goat connect` in your terminal and open the freshly printed URL.",
 } as const;

 /**
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx`

User command guidance/search on web/desktop/mobile; no wire-contract or layout change.

```diff
--- a/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx
+++ b/apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx
@@ -232,7 +232,7 @@
           />

           <View collapsable={false} className="gap-2">
-            <Text className="px-4 text-sm font-t3-medium text-foreground-muted">Or enter it</Text>
+            <Text className="px-4 text-sm font-goat-medium text-foreground-muted">Or enter it</Text>
             <View
               collapsable={false}
               className={cn(
@@ -360,7 +360,7 @@
                 weight="light"
               />
               <Text
-                className={cn("font-t3-medium text-sm", light ? "text-black/70" : "text-white/80")}
+                className={cn("font-goat-medium text-sm", light ? "text-black/70" : "text-white/80")}
               >
                 Tap to scan
               </Text>
@@ -368,7 +368,7 @@
           )}
         </View>
         <Text className={cn("text-center text-sm", light ? "text-black/70" : "text-white/80")}>
-          Scan the code from t3 pair or desktop Connections settings
+          Scan the code from goat pair or desktop Connections settings
         </Text>
       </View>
     </Pressable>
@@ -392,7 +392,7 @@

   return (
     <View collapsable={false} className="gap-2">
-      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">
+      <Text className="px-4 text-sm font-goat-medium text-foreground-muted">
         Or use the managed relay
       </Text>
       {isSignedIn ? (
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/shared/src/cliRelease.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/packages/shared/src/cliRelease.test.ts
+++ b/packages/shared/src/cliRelease.test.ts
@@ -14,9 +14,9 @@
 describe("cliRelease", () => {
   it("names archives by version and platform, zip only on Windows", () => {
     expect(cliArchiveFileName("1.2.3-preview.20260911.4", "linux-x64")).toBe(
-      "t3-1.2.3-preview.20260911.4-linux-x64.tar.gz",
+      "goat-1.2.3-preview.20260911.4-linux-x64.tar.gz",
     );
-    expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("t3-1.2.3-win32-x64.zip");
+    expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("goat-1.2.3-win32-x64.zip");
   });

   it("only maps platforms and architectures that have a release archive", () => {
@@ -35,22 +35,22 @@
     expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
       "https://github.com/goat-si/goat/releases/download/v1.2.3",
     );
-    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
-      "https://mirror.example/t3/v1.2.3",
+    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/goat/")).toBe(
+      "https://mirror.example/goat/v1.2.3",
     );
   });

   it("parses sha256sum output including binary-mode markers", () => {
     const checksums = parseChecksums(
       [
-        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
-        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
+        `${"a".repeat(64)}  goat-1.2.3-linux-x64.tar.gz`,
+        `${"B".repeat(64)} *goat-1.2.3-win32-x64.zip`,
         "not a checksum line",
         "",
       ].join("\n"),
     );
-    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
-    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
+    expect(checksums.get("goat-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
+    expect(checksums.get("goat-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
     expect(checksums.size).toBe(2);
   });

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-npm-platform-packages.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/scripts/build-npm-platform-packages.test.ts
+++ b/scripts/build-npm-platform-packages.test.ts
@@ -52,7 +52,7 @@
   const archivesDir = path.join(root, "archives");
   yield* fs.makeDirectory(archivesDir);
   for (const key of KEYS) {
-    const stem = `t3-${VERSION}-${key}`;
+    const stem = `goat-${VERSION}-${key}`;
     const stage = path.join(root, "stage", key);
     const contentDir = path.join(stage, stem);
     for (const dir of [
@@ -73,10 +73,10 @@
     );
     yield* fs.writeFileString(path.join(contentDir, "client/index.html"), "<html></html>\n");
     yield* fs.writeFileString(
-      path.join(contentDir, "t3"),
+      path.join(contentDir, "goat"),
       `#!/bin/sh\necho "stub ${key} $*"\nexit 7\n`,
     );
-    yield* fs.chmod(path.join(contentDir, "t3"), 0o755);
+    yield* fs.chmod(path.join(contentDir, "goat"), 0o755);
     const exit = yield* run("tar", ["-czf", path.join(archivesDir, `${stem}.tar.gz`), stem], {
       cwd: stage,
     });
@@ -132,8 +132,8 @@
       assert.deepStrictEqual(linuxManifest.os, ["linux"]);
       assert.deepStrictEqual(linuxManifest.cpu, ["x64"]);
       assert.deepStrictEqual(linuxManifest.files, [
-        "t3",
-        "t3.exe",
+        "goat",
+        "goat.exe",
         "client",
         "resource-monitor",
         "node_modules",
@@ -155,7 +155,7 @@
         "# @t3code/t3-linux-x64",
       );
       assert.isTrue(yield* fs.exists(path.join(linuxDir, "node_modules/node-pty")));
-      assert.equal(Number((yield* fs.stat(path.join(linuxDir, "t3"))).mode) & 0o111, 0o111);
+      assert.equal(Number((yield* fs.stat(path.join(linuxDir, "goat"))).mode) & 0o111, 0o111);

       const darwinManifest = yield* decodeManifest(
         yield* fs.readFileString(
@@ -171,7 +171,7 @@
       );
       assert.equal(launcherManifest.name, "t3");
       assert.equal(launcherManifest.version, VERSION);
-      assert.deepStrictEqual(launcherManifest.bin, { t3: "./bin/t3.js" });
+      assert.deepStrictEqual(launcherManifest.bin, { goat: "./bin/t3.js", t3: "./bin/t3.js" });
       assert.deepStrictEqual(launcherManifest.files, ["bin", "dist"]);
       assert.deepStrictEqual(launcherManifest.optionalDependencies, {
         "@t3code/t3-darwin-arm64": VERSION,
@@ -197,7 +197,7 @@
       assert.isTrue(lines.some((line) => line.endsWith(" package/node_modules/node-pty/")));
       assert.isTrue(lines.some((line) => line.endsWith(" package/package.json")));
       assert.isTrue(
-        lines.some((line) => /^-rwxr-xr-x .* package\/t3$/.test(line)),
+        lines.some((line) => /^-rwxr-xr-x .* package\/goat$/.test(line)),
         listing.stdout,
       );

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/pinnedRuntime.test.ts`

Existing install behavior now proves same-version upstream runtime is not reused/removed.

```diff
--- a/apps/server/src/cloud/pinnedRuntime.test.ts
+++ b/apps/server/src/cloud/pinnedRuntime.test.ts
@@ -21,7 +21,7 @@
 // and unpacks it with tar. The fake client serves both files; the fake runner
 // stands in for tar and drops the executable where extraction would.
 const version = "1.2.3";
-const archiveName = `t3-${version}-linux-x64.tar.gz`;
+const archiveName = `goat-${version}-linux-x64.tar.gz`;
 const archiveBytes = new TextEncoder().encode("not really a tarball");
 const archiveHex = (bytes: Uint8Array) =>
   Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
@@ -48,7 +48,7 @@
         if (input.command !== "tar" || stagingDir === undefined) {
           return yield* Effect.die(`unexpected command ${input.command}`);
         }
-        yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
+        yield* fs.writeFileString(path.join(stagingDir, "goat"), "#!/bin/sh\n").pipe(Effect.orDie);
         return {
           stdout: "",
           stderr: "",
@@ -70,6 +70,10 @@
       const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
       const requests: string[] = [];
       const commands: string[] = [];
+      const upstream = path.join(baseDir, "runtime", "versions", version);
+      yield* fs.makeDirectory(upstream, { recursive: true });
+      yield* fs.writeFileString(path.join(upstream, "t3"), "upstream runtime\n");
+      yield* fs.writeFileString(path.join(upstream, ".install-complete"), version);
       const paths = yield* ensurePinnedRuntimeInstalled({
         baseDir,
         version,
@@ -86,13 +90,16 @@
             Effect.orDie,
           ),
       });
-      assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));
+      assert.equal(paths.entryPath, path.join(paths.versionDir, "goat"));
       assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
       assert.deepEqual(requests, [
         `https://releases.example/download/v${version}/SHA256SUMS`,
         `https://releases.example/download/v${version}/${archiveName}`,
       ]);
       assert.deepEqual(commands, ["tar"]);
+      assert.equal(paths.versionDir, path.join(baseDir, "runtime", "goat", "versions", version));
+      assert.equal(yield* fs.readFileString(path.join(upstream, "t3")), "upstream runtime\n");
+      assert.equal(yield* fs.readFileString(path.join(upstream, ".install-complete")), version);
       assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
       assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
     }),
@@ -214,7 +221,7 @@
       assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
       assert.isTrue(progress.every((event) => event.stage === "download"));
       assert.isTrue(cancelled);
-      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
+      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "goat", "versions")), []);
     }),
   );

@@ -236,9 +243,9 @@
         validate: () => Effect.die("must not validate an unverified archive"),
       }).pipe(Effect.flip);
       assert.instanceOf(error, PinnedRuntimeInstallError);
-      assert.equal(error.step, "verifying the t3 release archive checksum");
+      assert.equal(error.step, "verifying the GOAT release archive checksum");
       assert.deepEqual(commands, []);
-      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
+      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "goat", "versions")), []);
     }),
   );

@@ -390,7 +397,7 @@

       yield* Deferred.await(started);
       yield* Fiber.interrupt(install);
-      const versionsDir = path.join(baseDir, "runtime", "versions");
+      const versionsDir = path.join(baseDir, "runtime", "goat", "versions");
       assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
     }),
   );
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/serviceLauncher.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/server/src/serviceLauncher.test.ts
+++ b/apps/server/src/serviceLauncher.test.ts
@@ -86,7 +86,7 @@
   childSource: string,
 ) =>
   Effect.gen(function* () {
-    const entryPath = path.join(versionDir, "t3");
+    const entryPath = path.join(versionDir, "goat");
     yield* fs.makeDirectory(versionDir, { recursive: true });
     yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
     yield* fs.chmod(entryPath, 0o755);
@@ -124,7 +124,7 @@
       yield* writeFakeRuntime(
         fs,
         path,
-        path.join(root, "runtime", "versions", "1.0.0"),
+        path.join(root, "runtime", "goat", "versions", "1.0.0"),
         "setInterval(() => {}, 1_000);\n",
       );
       yield* Effect.promise(() =>
@@ -167,7 +167,7 @@
       yield* writeFakeRuntime(
         fs,
         path,
-        path.join(root, "runtime", "versions", "1.0.0"),
+        path.join(root, "runtime", "goat", "versions", "1.0.0"),
         "setInterval(() => {}, 1_000);\n",
       );
       yield* Effect.promise(() =>
@@ -217,7 +217,7 @@
         yield* writeFakeRuntime(
           fs,
           path,
-          path.join(root, "runtime", "versions", version),
+          path.join(root, "runtime", "goat", "versions", version),
           childSource,
         );
       }
@@ -267,7 +267,7 @@
         yield* writeFakeRuntime(
           fs,
           path,
-          path.join(root, "runtime", "versions", version),
+          path.join(root, "runtime", "goat", "versions", version),
           childSource,
         );
       }
@@ -326,7 +326,7 @@
         yield* writeFakeRuntime(
           fs,
           path,
-          path.join(root, "runtime", "versions", version),
+          path.join(root, "runtime", "goat", "versions", version),
           childSource,
         );
       }
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/desktop/src/wsl/DesktopWslEnvironment.test.ts
+++ b/apps/desktop/src/wsl/DesktopWslEnvironment.test.ts
@@ -199,8 +199,8 @@
     expect(script).not.toContain('rm -rf "$runtime_lock"');
     expect(script).toContain('mv -T "$runtime_root" "$runtime_stale"');
     expect(script).toContain('mktemp -d "$runtime_parent/.1.2.3-x64.tmp.XXXXXX"');
-    // The release archive wraps everything in one `t3-<version>-linux-x64/`
-    // directory; stripping it puts the executable at `$runtime_root/t3`.
+    // The release archive wraps everything in one `goat-<version>-linux-x64/`
+    // directory; stripping it puts the executable at `$runtime_root/goat`.
     expect(script).toContain(
       "tar -xzf '/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz' -C \"$runtime_tmp\" --strip-components=1",
     );
@@ -284,7 +284,7 @@
     // The same proof the SSH runner and CLI installers use: executable, and
     // `--version` exits 0. That is what decides arch and loadability, so no
     // separate native probe is needed.
-    expect(script).toContain('  [ -x "$1/t3" ] && "$1/t3" --version >/dev/null 2>&1');
+    expect(script).toContain('  [ -x "$1/goat" ] && "$1/goat" --version >/dev/null 2>&1');

     // Readiness gates the short-circuit, so a cache whose executable broke
     // reinstalls from the archive instead of being reused forever.
@@ -306,7 +306,7 @@
       "b".repeat(64),
     );

-    expect(script).toContain(`  sha256sum "$1/t3" 2>/dev/null | cut -d ' ' -f 1`);
+    expect(script).toContain(`  sha256sum "$1/goat" 2>/dev/null | cut -d ' ' -f 1`);
     expect(script).toContain(
       '    [ "$recorded_entry_digest" = "$(runtime_server_entry_digest "$runtime_root")" ]',
     );
@@ -370,7 +370,7 @@
   it("never deletes a runtime another backend is running from", () => {
     const script = buildWslRuntimePruneScript("1.2.3/x64");

-    // The running backend's argv holds `<runtime>/t3`, so
+    // The running backend's argv holds `<runtime>/goat`, so
     // the process itself is the lease and exiting releases it. Nothing has to be
     // registered up front, which is what makes this cover backends already
     // running from an older version that knows nothing about pruning.
@@ -431,12 +431,12 @@
         "work=$(mktemp -d)",
         // Mirrors the release archive: one top-level versioned directory that
         // holds the executable and its native addons.
-        'stage="$work/stage/t3-0.0.0-linux-x64"',
+        'stage="$work/stage/goat-0.0.0-linux-x64"',
         'mkdir -p "$stage/node_modules/node-pty/build/Release" "$work/home"',
-        `printf '%s' ${sh(SERVER_ENTRY_SOURCE)} > "$stage/t3"`,
-        'chmod +x "$stage/t3"',
+        `printf '%s' ${sh(SERVER_ENTRY_SOURCE)} > "$stage/goat"`,
+        'chmod +x "$stage/goat"',
         `printf '%s' 'pty-native-payload' > "$stage/node_modules/node-pty/build/Release/pty.node"`,
-        `tar -czf "$work/wsl-runtime.tar.gz" -C "$work/stage" t3-0.0.0-linux-x64`,
+        `tar -czf "$work/wsl-runtime.tar.gz" -C "$work/stage" goat-0.0.0-linux-x64`,
         `printf 'work:%s\\n' "$work"`,
         `printf 'archiveSha:%s\\n' "$(sha256sum "$work/wsl-runtime.tar.gz" | cut -d ' ' -f 1)"`,
       ].join("\n"),
@@ -463,7 +463,7 @@
       runtimeId,
       runtimeParent: `${work}/home/.t3/wsl-runtime`,
       runtimeRoot: `${work}/home/.t3/wsl-runtime/${runtimeId}`,
-      serverEntry: `${work}/home/.t3/wsl-runtime/${runtimeId}/t3`,
+      serverEntry: `${work}/home/.t3/wsl-runtime/${runtimeId}/goat`,
       installScript,
       install: (archive?: string, sha?: string) => runShell(installScript(archive, sha)),
     };
@@ -734,7 +734,7 @@
         `runtime_root=${sh(fixture.runtimeRoot)}`,
         `runtime_parent=${sh(fixture.runtimeParent)}`,
         'rm "$runtime_root/.t3code-wsl-runtime-ready"',
-        holdRuntimeBusy('"$runtime_root/t3"'),
+        holdRuntimeBusy('"$runtime_root/goat"'),
         fixture.installScript(),
         'stale=$(find "$runtime_parent" -maxdepth 1 -type d -name ".sha256-*.stale.*" -print -quit)',
         'test -n "$stale"',
@@ -768,7 +768,7 @@
         'touch -d "4 minutes ago" "$runtime_parent/sha256-active"',
         'touch -d "3 minutes ago" "$runtime_parent/sha256-old"',
         'touch -d "2 minutes ago" "$runtime_parent/sha256-locked"',
-        holdRuntimeBusy('"$runtime_parent/sha256-active/t3"'),
+        holdRuntimeBusy('"$runtime_parent/sha256-active/goat"'),
         holdInstallLock('"$runtime_parent/.sha256-locked.install.lock"'),
         `HOME="$home"`,
         "export HOME",
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
+++ b/apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
@@ -475,7 +475,7 @@
             "--exec",
             "env",
             `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${resolvedPath}`,
-            `${linuxAppRoot}/t3`,
+            `${linuxAppRoot}/goat`,
             "--bootstrap-fd",
             "0",
           ]);
@@ -518,9 +518,9 @@

           assert.deepEqual(observedRuntimeIds, [`sha256-${firstHash}`, `sha256-${secondHash}`]);
           assert.equal(first.wslRuntimeId, observedRuntimeIds[0]);
-          assert.include(first.args, `/runtime/sha256-${firstHash}/t3`);
+          assert.include(first.args, `/runtime/sha256-${firstHash}/goat`);
           assert.equal(second.wslRuntimeId, observedRuntimeIds[1]);
-          assert.include(second.args, `/runtime/sha256-${secondHash}/t3`);
+          assert.include(second.args, `/runtime/sha256-${secondHash}/goat`);
           assert.isUndefined(invalidIdentity.wslRuntimeId);
           assert.include(invalidIdentity.args, "/usr/bin/node");
           assert.include(invalidIdentity.args, `${mountedAppRoot}/apps/server/dist/bin.mjs`);
@@ -573,7 +573,7 @@
             }),
           probeRuntime: (_distro, root) => {
             observedProbeRoots.push(root);
-            return { ok: false, reason: `${root}/t3 --version failed (exit 127)` };
+            return { ok: false, reason: `${root}/goat --version failed (exit 127)` };
           },
           ensureNodePty: (_distro, root) => {
             observedNodePtyRoots.push(root);
@@ -590,7 +590,7 @@
           assert.deepEqual(observedNodePtyRoots, [mountedAppRoot]);
           assert.include(config.args, "/usr/bin/node");
           assert.include(config.args, `${mountedAppRoot}/apps/server/dist/bin.mjs`);
-          assert.notInclude(config.args, `${stagedAppRoot}/t3`);
+          assert.notInclude(config.args, `${stagedAppRoot}/goat`);
           assert.equal(config.entryPath, mountedEntryPath);
           assert.isUndefined(config.wslRuntimeId);
           assert.isTrue(Option.isNone(config.preflightFailure));
@@ -683,7 +683,7 @@
         yield* fileSystem.writeFileString(entryPath, "");

         const nodePath = "/home/test user's/.nvm/versions/node/v22.0.0/bin/node";
-        const linuxAppRoot = "/tmp/t3 code's launch";
+        const linuxAppRoot = "/tmp/goat code's launch";
         const linuxEntryPath = `${linuxAppRoot}/apps/server/dist/bin.mjs`;
         const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
         const devServerUrl = "http://127.0.0.1:5733/dev%20assets/?label=hello%20world";
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/build-desktop-artifact.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/scripts/build-desktop-artifact.test.ts
+++ b/scripts/build-desktop-artifact.test.ts
@@ -117,7 +117,7 @@
   const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
   const contentRoot = path.join(input.root, "content");
   const members = [
-    `${input.stem}/t3`,
+    `${input.stem}/goat`,
     `${input.stem}/client/index.html`,
     `${input.stem}/node_modules/node-pty/package.json`,
     `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
@@ -231,7 +231,7 @@
           yield* makeLinuxCliArchiveFixture({
             root: path.join(tempDir, "wsl-runtime"),
             stem: "apps",
-            omitMembers: ["apps/t3", "apps/client/index.html"],
+            omitMembers: ["apps/goat", "apps/client/index.html"],
             extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
           })
         : yield* makeLinuxCliArchiveFixture({
@@ -1219,7 +1219,7 @@
               repoRoot,
               `native/${backend}-snap-shot/target`,
               target,
-              `release/t3-${backend}-snap-shot`,
+              `release/goat-${backend}-snap-shot`,
             );
             const stageResourcesDir = path.join(repoRoot, "stage", backend, arch);
             const spawner = Layer.succeed(
@@ -1253,7 +1253,7 @@
             }).pipe(Effect.provide(spawner));
             const installed = path.join(
               stageResourcesDir,
-              `${backend}-capture/t3-${backend}-snap-shot`,
+              `${backend}-capture/goat-${backend}-snap-shot`,
             );
             assert.equal(yield* fs.readFileString(installed), `helper-${arch}`);
             assert.equal((yield* fs.stat(installed)).mode & 0o777, 0o755);
@@ -2203,18 +2203,18 @@
     });
     // Both the staging and the packaging config hang off this one decision:
     // Windows only, and only when CI handed the build a Linux CLI archive.
-    const runtimeArchivePath = "/tmp/t3-1.2.3-linux-x64.tar.gz";
+    const runtimeArchivePath = "/tmp/goat-1.2.3-linux-x64.tar.gz";
     assert.isTrue(bundlesWslRuntime({ platform: "win", runtimeArchivePath }));
     assert.isFalse(bundlesWslRuntime({ platform: "win", runtimeArchivePath: undefined }));
     assert.isFalse(bundlesWslRuntime({ platform: "linux", runtimeArchivePath }));
     assert.isFalse(bundlesWslRuntime({ platform: "mac", runtimeArchivePath }));
-    assert.equal(wslRuntimeArchiveStem("1.2.3", "x64"), "t3-1.2.3-linux-x64");
+    assert.equal(wslRuntimeArchiveStem("1.2.3", "x64"), "goat-1.2.3-linux-x64");
   });

   it("parses Windows bsdtar member listings with CRLF line endings", () => {
     assert.deepStrictEqual(
-      parseWslRuntimeArchiveMembers("./t3-1.2.3-linux-x64/t3\r\nt3-1.2.3-linux-x64/client/\r\n"),
-      ["t3-1.2.3-linux-x64/t3", "t3-1.2.3-linux-x64/client"],
+      parseWslRuntimeArchiveMembers("./goat-1.2.3-linux-x64/goat\r\ngoat-1.2.3-linux-x64/client/\r\n"),
+      ["goat-1.2.3-linux-x64/goat", "goat-1.2.3-linux-x64/client"],
     );
   });

@@ -2226,7 +2226,7 @@
         const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-stage-" });
         const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
           root,
-          stem: "t3-1.2.3-linux-x64",
+          stem: "goat-1.2.3-linux-x64",
         });
         const stageAppDir = path.join(root, "app");
         const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
@@ -2254,7 +2254,7 @@
         const path = yield* Path.Path;
         const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-missing-" });
         const error = yield* stageWslRuntimeArchive({
-          sourceArchivePath: path.join(root, "t3-1.2.3-linux-x64.tar.gz"),
+          sourceArchivePath: path.join(root, "goat-1.2.3-linux-x64.tar.gz"),
           archivePath: path.join(root, WSL_RUNTIME_ARCHIVE_NAME),
           hashPath: path.join(root, WSL_RUNTIME_ARCHIVE_HASH_NAME),
         }).pipe(Effect.flip);
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.test.ts`

Real shell probe/upload proves marker-only cache is missed and repaired while same-version upstream bytes survive; retain race and second-client lifecycle cases.

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -118,13 +118,13 @@
   const fs = yield* FileSystem.FileSystem;
   const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
   const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preparation-" });
-  const stem = `t3-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
+  const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
   const stage = `${root}/stage/${stem}`;
   const directory = `${root}/mirror/v${ARCHIVE.archiveVersion}`;
   yield* fs.makeDirectory(stage, { recursive: true });
   yield* fs.makeDirectory(directory, { recursive: true });
-  yield* fs.writeFileString(`${stage}/t3`, `#!/bin/sh\necho t3 v${ARCHIVE.archiveVersion}\n`);
-  yield* fs.chmod(`${stage}/t3`, 0o700);
+  yield* fs.writeFileString(`${stage}/goat`, `#!/bin/sh\necho t3 v${ARCHIVE.archiveVersion}\n`);
+  yield* fs.chmod(`${stage}/goat`, 0o700);
   const child = yield* spawner.spawn(
     ChildProcess.make("tar", ["-czf", `${directory}/${stem}.tar.gz`, "-C", `${root}/stage`, stem]),
   );
@@ -230,10 +230,10 @@
       script,
       "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
     );
-    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
-    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
+    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION"');
+    assert.include(script, 'T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
     assert.include(script, "SHA256SUMS");
-    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
+    assert.include(script, 'exec "$T3_RUNTIME_DIR/goat" "$@"');
     assert.notInclude(script, "npx");
     assert.notInclude(script, "npm exec");
     assert.notInclude(script, "t3@latest");
@@ -242,7 +242,7 @@
     // the completion marker after acquiring it.
     assert.include(
       script,
-      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
+      'T3_LOCK="$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"',
     );
     // mkdir is the exclusive create; the pid follows atomically. A dead owner
     // is reclaimed at once, a never-published owner after a short grace.
@@ -257,7 +257,7 @@
     assert.notInclude(script, "-mmin");
     assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
     assert.isBelow(
-      script.indexOf('"$T3_STAGING/t3" --version'),
+      script.indexOf('"$T3_STAGING/goat" --version'),
       script.indexOf('> "$T3_STAGING/.install-complete"'),
     );
     // Node discovery is defined for the dev path but only ever invoked inside
@@ -274,10 +274,10 @@

     const launch = SshTunnel.buildRemoteLaunchScript({
       ...ARCHIVE,
-      releaseBaseUrl: "https://mirror.example/t3/",
+      releaseBaseUrl: "https://mirror.example/goat/",
     });
     assert.include(launch, "T3_ARCHIVE_MODE=1");
-    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
+    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/goat'");
     assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
     assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
     assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
@@ -849,17 +849,17 @@
         yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
       }
       if (mode === "ready") {
-        const runtime = `${root}/.t3/runtime/versions/${retainedVersion}`;
+        const runtime = `${root}/.t3/runtime/goat/versions/${retainedVersion}`;
         yield* fs.makeDirectory(runtime, { recursive: true });
-        yield* fs.writeFileString(`${runtime}/t3`, "#!/bin/sh\nexit 0\n");
-        yield* fs.chmod(`${runtime}/t3`, 0o700);
+        yield* fs.writeFileString(`${runtime}/goat`, "#!/bin/sh\nexit 0\n");
+        yield* fs.chmod(`${runtime}/goat`, 0o700);
         yield* fs.writeFileString(`${runtime}/.install-complete`, retainedVersion);
       }
       const archiveDirectory = `${root}/missing-cache`;
       const bytes = new Uint8Array([0, 128, 255]);
       const crypto = yield* Crypto.Crypto;
       const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes));
-      const asset = `t3-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
+      const asset = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`;
       const calls: string[] = [];
       const spans: Tracer.Span[] = [];
       let cacheReads = 0;
@@ -1008,11 +1008,11 @@
       const fs = yield* FileSystem.FileSystem;
       const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-preparation-" });
-      const runtime = `${root}/.t3/runtime/versions/${ARCHIVE.archiveVersion}`;
+      const runtime = `${root}/.t3/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
       const state = `${root}/.t3/ssh-launch/711bc738002d72fd`;
       yield* fs.makeDirectory(runtime, { recursive: true });
       yield* fs.makeDirectory(state, { recursive: true });
-      const cli = `${runtime}/t3`;
+      const cli = `${runtime}/goat`;
       yield* fs.writeFileString(
         cli,
         `#!${process.execPath}
@@ -1213,7 +1213,7 @@
       if (!ready)
         assert.equal(
           (yield* fs.readFileString(
-            `${root}/.t3/runtime/versions/${ARCHIVE.archiveVersion}/.install-complete`,
+            `${root}/.t3/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-complete`,
           )).trim(),
           ARCHIVE.archiveVersion,
         );
@@ -1224,7 +1224,7 @@
     Effect.gen(function* () {
       const { directory, fs } = yield* makeUploadFixture();
       yield* fs.truncate(
-        `${directory}/t3-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`,
+        `${directory}/goat-${ARCHIVE.archiveVersion}-${platform}-${arch}.tar.gz`,
         268435457,
       );
       let calls = 0;
@@ -1397,14 +1397,14 @@
     const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
     const platform = hostPlatform === "darwin" ? "darwin" : "linux";
     const arch = hostArch === "arm64" ? "arm64" : "x64";
-    const stem = `t3-${archiveVersion}-${platform}-${arch}`;
+    const stem = `goat-${archiveVersion}-${platform}-${arch}`;
     const stage = `${root}/stage/${stem}`;
     const release = `${root}/mirror/v${archiveVersion}`;
     const script = [
       "set -eu",
       `mkdir -p '${stage}' '${release}'`,
-      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/t3'`,
-      `chmod +x '${stage}/t3'`,
+      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${stage}/goat'`,
+      `chmod +x '${stage}/goat'`,
       `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
       `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
     ].join("\n");
@@ -1412,6 +1412,41 @@
     assert.equal(Number(yield* child.exitCode), 0);
     return `file://${root}/mirror`;
   });
+
+  it.effect.skipIf(windowsHost)("uploads GOAT beside same-version upstream and repairs a marker-only cache", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      for (const markerOnly of [false, true]) {
+        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-collision-" });
+        yield* makeMirror(root);
+        const platform = hostPlatform === "darwin" ? "darwin" : "linux";
+        const arch = hostArch === "arm64" ? "arm64" : "x64";
+        const bytes = yield* fs.readFile(`${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`);
+        const checksum = (yield* fs.readFileString(`${root}/mirror/v${archiveVersion}/SHA256SUMS`)).slice(0, 64);
+        const upstream = `${root}/.t3/runtime/versions/${archiveVersion}`;
+        yield* fs.makeDirectory(upstream, { recursive: true });
+        yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
+        yield* fs.writeFileString(`${upstream}/.install-complete`, archiveVersion);
+        const runtime = `${root}/.t3/runtime/goat/versions/${archiveVersion}`;
+        if (markerOnly) {
+          yield* fs.makeDirectory(runtime, { recursive: true });
+          yield* fs.writeFileString(`${runtime}/.install-complete`, archiveVersion);
+        }
+        const probe = yield* runShell(root, ["-c", SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion)]);
+        assert.equal(probe.exitCode, 0, probe.stderr);
+        assert.equal(JSON.parse(probe.stdout).ready, false);
+        const result = yield* runUpload(root, SshTunnel.buildRemoteUploadScript(ARCHIVE, checksum), bytes);
+        assert.equal(result.exitCode, 0, result.stderr);
+        assert.isTrue(yield* fs.exists(`${runtime}/goat`));
+        assert.equal((yield* fs.readFileString(`${runtime}/.install-complete`)).trim(), archiveVersion);
+        assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
+        assert.equal(yield* fs.readFileString(`${upstream}/.install-complete`), archiveVersion);
+        const after = yield* runShell(root, ["-c", SshTunnel.buildRemoteRuntimeProbeScript(archiveVersion)]);
+        assert.equal(after.exitCode, 0, after.stderr);
+        assert.equal(JSON.parse(after.stdout).ready, true);
+      }
+    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
+  );

   it.effect.skipIf(windowsHost)("fails on an uploaded archive checksum mismatch", () =>
     Effect.gen(function* () {
@@ -1421,7 +1456,7 @@
       const platform = hostPlatform === "darwin" ? "darwin" : "linux";
       const arch = hostArch === "arm64" ? "arm64" : "x64";
       const bytes = yield* fs.readFile(
-        `${root}/mirror/v${archiveVersion}/t3-${archiveVersion}-${platform}-${arch}.tar.gz`,
+        `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`,
       );
       const result = yield* runUpload(
         root,
@@ -1434,9 +1469,9 @@
       assert.equal(result.exitCode, 1);
       assert.include(result.stderr, "Checksum mismatch");
       assert.isFalse(
-        yield* fs.exists(`${root}/.t3/runtime/versions/${archiveVersion}/.install-complete`),
-      );
-      assert.deepEqual(yield* fs.readDirectory(`${root}/.t3/runtime/versions`), []);
+        yield* fs.exists(`${root}/.t3/runtime/goat/versions/${archiveVersion}/.install-complete`),
+      );
+      assert.deepEqual(yield* fs.readDirectory(`${root}/.t3/runtime/goat/versions`), []);
       assert.notInclude(result.stderr, "curl");
     }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
   );
@@ -1448,7 +1483,7 @@
       yield* makeMirror(root);
       const platform = hostPlatform === "darwin" ? "darwin" : "linux";
       const arch = hostArch === "arm64" ? "arm64" : "x64";
-      const file = `${root}/mirror/v${archiveVersion}/t3-${archiveVersion}-${platform}-${arch}.tar.gz`;
+      const file = `${root}/mirror/v${archiveVersion}/goat-${archiveVersion}-${platform}-${arch}.tar.gz`;
       const bytes = yield* fs.readFile(file);
       const checksums = yield* fs.readFileString(`${root}/mirror/v${archiveVersion}/SHA256SUMS`);
       const script = SshTunnel.buildRemoteUploadScript(
@@ -1463,7 +1498,7 @@
         assert.equal(result.exitCode, 0, result.stderr);
         assert.include(result.stdout, `t3 v${archiveVersion}`);
       }
-      const versions = `${root}/.t3/runtime/versions`;
+      const versions = `${root}/.t3/runtime/goat/versions`;
       assert.deepEqual(yield* fs.readDirectory(versions), [archiveVersion]);
       assert.equal(
         (yield* fs.readFileString(`${versions}/${archiveVersion}/.install-complete`)).trim(),
@@ -1495,7 +1530,7 @@
           assert.equal(result.exitCode, 0, result.stderr);
           assert.include(result.stdout, `t3 v${archiveVersion}`);
         }
-        const versionsDir = `${home}/.t3/runtime/versions`;
+        const versionsDir = `${home}/.t3/runtime/goat/versions`;
         assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
         assert.equal(
           (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/update.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/server/src/cli/update.test.ts
+++ b/apps/server/src/cli/update.test.ts
@@ -14,9 +14,9 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
-      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
-      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
-      const launcher = path.join(root, "bin/t3");
+      const oldExe = path.join(root, "runtime/goat/versions/1.0.0/goat");
+      const newExe = path.join(root, "runtime/goat/versions/2.0.0/goat");
+      const launcher = path.join(root, "bin/goat");
       for (const file of [oldExe, newExe]) {
         yield* fs.makeDirectory(path.dirname(file), { recursive: true });
         yield* fs.writeFileString(file, "");
@@ -26,7 +26,7 @@

       const repointed = yield* repointLauncher({
         launchedAs: launcher,
-        versionsDir: path.join(root, "runtime/versions"),
+        versionsDir: path.join(root, "runtime/goat/versions"),
         targetEntryPath: newExe,
       });

@@ -40,13 +40,13 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
-      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
-      const copy = path.join(root, "copy/t3");
-      const foreign = path.join(root, "foreign/t3");
-      const elsewhere = path.join(root, "elsewhere/t3");
+      const newExe = path.join(root, "runtime/goat/versions/2.0.0/goat");
+      const copy = path.join(root, "copy/goat");
+      const foreign = path.join(root, "foreign/goat");
+      const elsewhere = path.join(root, "elsewhere/goat");
       // Another install's versions tree: same shape, different home.
-      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
-      const otherLauncher = path.join(root, "other/bin/t3");
+      const otherHome = path.join(root, "other/runtime/goat/versions/1.0.0/goat");
+      const otherLauncher = path.join(root, "other/bin/goat");
       for (const file of [newExe, copy, elsewhere, otherHome]) {
         yield* fs.makeDirectory(path.dirname(file), { recursive: true });
         yield* fs.writeFileString(file, "");
@@ -59,7 +59,7 @@
       for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
         const repointed = yield* repointLauncher({
           launchedAs,
-          versionsDir: path.join(root, "runtime/versions"),
+          versionsDir: path.join(root, "runtime/goat/versions"),
           targetEntryPath: newExe,
         });
         assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
@@ -74,24 +74,24 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
-      const launcher = path.join(root, "bin/t3");
+      const launcher = path.join(root, "bin/goat");
       yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
       yield* fs.writeFileString(launcher, "");

       const bare = yield* resolveLauncherPath.pipe(
-        Effect.provideService(HostProcess.InvokedAs, "t3"),
+        Effect.provideService(HostProcess.InvokedAs, "goat"),
         Effect.provideService(HostProcess.Environment, {
           PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
         }),
         Effect.provideService(HostProcess.WorkingDirectory, root),
       );
       const relative = yield* resolveLauncherPath.pipe(
-        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
+        Effect.provideService(HostProcess.InvokedAs, "./bin/goat"),
         Effect.provideService(HostProcess.Environment, { PATH: "" }),
         Effect.provideService(HostProcess.WorkingDirectory, root),
       );
       const absent = yield* resolveLauncherPath.pipe(
-        Effect.provideService(HostProcess.InvokedAs, "t3"),
+        Effect.provideService(HostProcess.InvokedAs, "goat"),
         Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
         Effect.provideService(HostProcess.WorkingDirectory, root),
       );
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/uninstall.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/server/src/cli/uninstall.test.ts
+++ b/apps/server/src/cli/uninstall.test.ts
@@ -13,16 +13,16 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
-      const versionsDir = path.join(root, "runtime/versions");
-      const exe = path.join(versionsDir, "1.0.0/t3");
-      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
-      const copy = path.join(root, "copy/t3");
+      const versionsDir = path.join(root, "runtime/goat/versions");
+      const exe = path.join(versionsDir, "1.0.0/goat");
+      const otherExe = path.join(root, "other/runtime/goat/versions/1.0.0/goat");
+      const copy = path.join(root, "copy/goat");
       for (const file of [exe, otherExe, copy]) {
         yield* fs.makeDirectory(path.dirname(file), { recursive: true });
         yield* fs.writeFileString(file, "");
       }
-      const ours = path.join(root, "bin/t3");
-      const theirs = path.join(root, "other/bin/t3");
+      const ours = path.join(root, "bin/goat");
+      const theirs = path.join(root, "other/bin/goat");
       yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
       yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
       yield* fs.symlink(exe, ours);
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliShim.test.ts`

Update real archive/install/spawn/ownership fixtures and existing observable outcomes; retain npm package paths and frozen compatibility ids.

```diff
--- a/apps/desktop/src/app/DesktopCliShim.test.ts
+++ b/apps/desktop/src/app/DesktopCliShim.test.ts
@@ -16,7 +16,7 @@
 });

 const tempRoot = () => {
-  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
+  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cli-shim-"));
   directories.push(root);
   return root;
 };
@@ -26,9 +26,9 @@
   NodeFS.writeFileSync(path, content, { mode: 0o755 });
 };

-/** Writes the launcher for `target` at `<root>/bin/t3`, with `<root>/home` as its T3 home. */
+/** Writes the launcher for `target` at `<root>/bin/goat`, with `<root>/home` as its T3 home. */
 const writeShim = (root: string, target: CliShimTarget) => {
-  const shim = NodePath.join(root, "bin", "t3");
+  const shim = NodePath.join(root, "bin", "goat");
   writeExecutable(shim, renderCliShim({ target, shimPath: shim, t3Home: `${root}/home` }));
   return shim;
 };
@@ -114,7 +114,7 @@
     expect(run(shim, []).stdout).toContain(`home=${root}/home`);
     expect(run(shim, [], { T3CODE_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
     // Run by a relative path, it still names itself absolutely.
-    const relative = NodeChildProcess.spawnSync("./bin/t3", [], { cwd: root, encoding: "utf8" });
+    const relative = NodeChildProcess.spawnSync("./bin/goat", [], { cwd: root, encoding: "utf8" });
     expect(relative.stdout).toContain(`cli=${shim}`);
   });

@@ -151,7 +151,7 @@
     const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
     const script = renderCliShim({
       target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
-      shimPath: "C:\\Users\\José\\.t3\\bin\\t3.cmd",
+      shimPath: "C:\\Users\\José\\.t3\\bin\\goat.cmd",
       t3Home: "C:\\Users\\José\\.t3",
     });
     const lines = script.split("\r\n");
@@ -165,13 +165,13 @@
       (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
     );
     expect(bare).toEqual([]);
-    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\t3.cmd"');
+    expect(lines).toContain('set "T3CODE_CLI_PATH=C:\\Users\\José\\.t3\\bin\\goat.cmd"');
   });

   it("switches the Windows console to UTF-8 only when a path needs it", () => {
     const ascii = renderCliShim({
       target: { kind: "windows", executable: "C:\\T3\\T3 Code.exe", entry: "C:\\T3\\bin.mjs" },
-      shimPath: "C:\\Users\\me\\.t3\\bin\\t3.cmd",
+      shimPath: "C:\\Users\\me\\.t3\\bin\\goat.cmd",
       t3Home: "C:\\Users\\me\\.t3",
     });
     // A Ctrl-C that ends the batch would leave the console switched.
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/desktop/src/app/DesktopCliCommand.test.ts`

Keep ownership behavior tests plus real GOAT/upstream coexistence and foreign-marker refusal.

```diff
--- a/apps/desktop/src/app/DesktopCliCommand.test.ts
+++ b/apps/desktop/src/app/DesktopCliCommand.test.ts
@@ -85,7 +85,7 @@
   return { registry, spawner };
 };

-// The machine's own PATH may already hold a t3; each test sets the PATH it means.
+// The machine's own PATH may already hold a goat; each test sets the PATH it means.
 const machinePath = process.env.PATH;
 beforeEach(() => {
   process.env.PATH = "";
@@ -95,46 +95,71 @@
 });

 it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
+  it.effect("keeps upstream t3 and rejects an upstream marker on a goat link", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const path = yield* Path.Path;
+      const home = yield* fs.makeTempDirectoryScoped();
+      const bin = path.join(home, ".local", "bin");
+      const upstream = path.join(bin, "t3");
+      const goat = path.join(bin, "goat");
+      yield* fs.makeDirectory(bin, { recursive: true });
+      const content = "#!/bin/sh\n# Written by T3 Code: runs the desktop app's bundled t3 CLI.\n";
+      yield* fs.writeFileString(upstream, content, { mode: 0o755 });
+      yield* fs.symlink(upstream, goat);
+      process.env.PATH = bin;
+      const command = yield* commandIn({ home });
+      expect((yield* command.state).installedPath).toBeNull();
+      expect((yield* Effect.flip(command.install)).message).toContain("Another goat");
+      yield* command.uninstall;
+      expect(yield* fs.readLink(goat)).toBe(upstream);
+      yield* fs.remove(goat);
+      expect((yield* command.install).installedPath).toBe(goat);
+      yield* command.uninstall;
+      expect(yield* fs.exists(goat)).toBe(false);
+      expect(yield* fs.readFileString(upstream)).toBe(content);
+    }).pipe(Effect.scoped),
+  );
   it.effect("links the launcher onto PATH and removes only that link", () =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const home = yield* fs.makeTempDirectoryScoped();
       const command = yield* commandIn({ home });
-      const link = path.join(home, ".local", "bin", "t3");
+      const link = path.join(home, ".local", "bin", "goat");

       expect(yield* command.state).toEqual({ supported: true, installedPath: null, onPath: false });
       // Install writes the launcher itself, even when no local backend ever did.
       const installed = yield* command.install;
       expect(installed.installedPath).toBe(link);
-      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "t3"));
+      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "goat"));
       expect((yield* command.install).installedPath).toBe(link);

       expect((yield* command.uninstall).installedPath).toBeNull();
       expect(yield* fs.exists(link)).toBe(false);
       // The launcher itself stays for setup commands.
-      expect(yield* fs.exists(path.join(home, ".t3", "bin", "t3"))).toBe(true);
-    }).pipe(Effect.scoped),
-  );
-
-  it.effect("never replaces or removes a t3 it did not create", () =>
-    Effect.gen(function* () {
-      const fs = yield* FileSystem.FileSystem;
-      const path = yield* Path.Path;
-      const home = yield* fs.makeTempDirectoryScoped();
-      const command = yield* commandIn({ home });
-      const theirs = path.join(home, ".local", "bin", "t3");
+      expect(yield* fs.exists(path.join(home, ".t3", "bin", "goat"))).toBe(true);
+    }).pipe(Effect.scoped),
+  );
+
+  it.effect("never replaces or removes a goat it did not create", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const path = yield* Path.Path;
+      const home = yield* fs.makeTempDirectoryScoped();
+      const command = yield* commandIn({ home });
+      const theirs = path.join(home, ".local", "bin", "goat");
       yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
-      yield* fs.writeFileString(theirs, "npm's t3\n");
+      yield* fs.writeFileString(theirs, "npm's goat\n");
       // Even a broken link in the next folder is someone else's.
       yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
-      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "t3"));
+      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "goat"));

       const error = yield* Effect.flip(command.install);
-      expect(error.message).toContain("Another t3 command is already installed");
-      yield* command.uninstall;
-      expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");
-      expect(yield* fs.readLink(path.join(home, "bin", "t3"))).toBe(path.join(home, "gone"));
+      expect(error.message).toContain("Another goat command is already installed");
+      yield* command.uninstall;
+      expect(yield* fs.readFileString(theirs)).toBe("npm's goat\n");
+      expect(yield* fs.readLink(path.join(home, "bin", "goat"))).toBe(path.join(home, "gone"));
     }).pipe(Effect.scoped),
   );

@@ -143,60 +168,60 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const home = yield* fs.makeTempDirectoryScoped();
-      const before = yield* commandIn({ home, baseDir: path.join(home, "old-t3") });
+      const before = yield* commandIn({ home, baseDir: path.join(home, "old-goat") });
       const link = (yield* before.install).installedPath;

-      const after = yield* commandIn({ home, baseDir: path.join(home, "new-t3") });
+      const after = yield* commandIn({ home, baseDir: path.join(home, "new-goat") });
       expect((yield* after.state).installedPath).toBe(link);
       // Installing again points the link at this home's launcher.
       expect((yield* after.install).installedPath).toBe(link);
-      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-t3", "bin", "t3"));
+      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-goat", "bin", "goat"));
       yield* after.uninstall;
-      expect(yield* fs.exists(path.join(home, ".local", "bin", "t3"))).toBe(false);
-      expect(yield* fs.exists(path.join(home, "bin", "t3"))).toBe(false);
-    }).pipe(Effect.scoped),
-  );
-
-  it.effect("does not read a large binary another t3 links to", () =>
+      expect(yield* fs.exists(path.join(home, ".local", "bin", "goat"))).toBe(false);
+      expect(yield* fs.exists(path.join(home, "bin", "goat"))).toBe(false);
+    }).pipe(Effect.scoped),
+  );
+
+  it.effect("does not read a large binary another goat links to", () =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const home = yield* fs.makeTempDirectoryScoped();
       // A big executable that happens to contain the marker text is still not ours.
-      const binary = path.join(home, "native-t3");
+      const binary = path.join(home, "native-goat");
       yield* fs.writeFileString(binary, `${"\0".repeat(64 * 1024)}${DesktopCliShim.MARKER}`);
       yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
-      yield* fs.symlink(binary, path.join(home, ".local", "bin", "t3"));
+      yield* fs.symlink(binary, path.join(home, ".local", "bin", "goat"));
       const command = yield* commandIn({ home });
       expect((yield* command.state).installedPath).toBeNull();
       yield* command.uninstall;
-      expect(yield* fs.readLink(path.join(home, ".local", "bin", "t3"))).toBe(binary);
-    }).pipe(Effect.scoped),
-  );
-
-  it.effect("refuses to install behind another t3 that runs first", () =>
+      expect(yield* fs.readLink(path.join(home, ".local", "bin", "goat"))).toBe(binary);
+    }).pipe(Effect.scoped),
+  );
+
+  it.effect("refuses to install behind another goat that runs first", () =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const home = yield* fs.makeTempDirectoryScoped();
       const shadow = path.join(home, "shadow");
       yield* fs.makeDirectory(shadow);
-      yield* fs.writeFileString(path.join(shadow, "t3"), "#!/bin/sh\n", { mode: 0o755 });
+      yield* fs.writeFileString(path.join(shadow, "goat"), "#!/bin/sh\n", { mode: 0o755 });
       process.env.PATH = [shadow, path.join(home, ".local", "bin")].join(":");

       const command = yield* commandIn({ home });
-      const theirs = path.join(shadow, "t3");
+      const theirs = path.join(shadow, "goat");
       expect((yield* command.state).shadowedBy).toBe(theirs);
       // A link behind it would never run, so nothing is created.
       const error = yield* Effect.flip(command.install);
       expect(error.message).toContain(theirs);
-      expect(yield* fs.exists(path.join(home, ".local", "bin", "t3"))).toBe(false);
+      expect(yield* fs.exists(path.join(home, ".local", "bin", "goat"))).toBe(false);

       yield* fs.remove(theirs);
       const installed = yield* command.install;
       expect(installed).toMatchObject({
         onPath: true,
-        installedPath: path.join(home, ".local", "bin", "t3"),
+        installedPath: path.join(home, ".local", "bin", "goat"),
       });
       expect(installed.shadowedBy).toBeUndefined();
     }).pipe(Effect.scoped),
@@ -218,7 +243,7 @@
       registry.failReads = false;
       const launcherDir = DesktopCliShim.launcherPath(
         environmentFor(yield* Path.Path, { home, baseDir: `${home}/.t3`, platform: "win32" }),
-      ).replace(/[\\/]t3\.cmd$/, "");
+      ).replace(/[\\/]goat\.cmd$/, "");
       yield* command.install;
       expect(registry.path).toBe(`${userPath};${launcherDir}`);
       yield* command.uninstall;
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/app.test.ts`

Expected help/error/command output follows goat; preserve npm runner expectations.

```diff
--- a/apps/server/src/cli/app.test.ts
+++ b/apps/server/src/cli/app.test.ts
@@ -123,9 +123,9 @@
     (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
   );

-describe("t3 server command safety", () => {
+describe("goat server command safety", () => {
   it.effect("rejects unknown command words without creating a home or project", () =>
-    withTempDirectory("t3-cli-unknown-", (root) =>
+    withTempDirectory("goat-cli-unknown-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, "home");
         for (const word of [
@@ -149,18 +149,18 @@
   );

   it.effect("shows help without creating state", () =>
-    withTempDirectory("t3-cli-help-", (root) =>
+    withTempDirectory("goat-cli-help-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, "home");
         const help = yield* runCli(["help"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);
-        expect(help).toMatchObject({ _tag: "ShowHelp", commandPath: ["t3"], errors: [] });
+        expect(help).toMatchObject({ _tag: "ShowHelp", commandPath: ["goat"], errors: [] });
         expect(yield* pathExists(baseDir)).toBe(false);
       }),
     ),
   );

   it.effect("refuses manual startup over a live server before creating directories", () =>
-    withTempDirectory("t3-cli-running-", (root) =>
+    withTempDirectory("goat-cli-running-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, "home");
         const stateDir = NodePath.join(baseDir, "userdata");
@@ -205,11 +205,11 @@
   );
 });

-describe("t3 app", () => {
+describe("goat app", () => {
   it.effect("rejects SSH before it tries to reach a desktop app", () =>
-    withTempDirectory("t3-app-ssh-test-", (root) =>
-      Effect.gen(function* () {
-        const baseDir = NodePath.join(root, "missing-t3-home");
+    withTempDirectory("goat-app-ssh-test-", (root) =>
+      Effect.gen(function* () {
+        const baseDir = NodePath.join(root, "missing-goat-home");
         const error = yield* runCli(["app", "--base-dir", baseDir], {
           SSH_CONNECTION: "client server",
         }).pipe(Effect.flip);
@@ -217,7 +217,7 @@
         expect(error).toMatchObject({
           _tag: "DesktopAppSshUnsupportedError",
           message:
-            "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.",
+            "`goat app` only controls a desktop app on the same machine. It cannot run over SSH.",
         });
         expect(yield* pathExists(baseDir)).toBe(false);
       }),
@@ -225,9 +225,9 @@
   );

   it.effect("rejects unsupported platforms without creating state", () =>
-    withTempDirectory("t3-app-platform-test-", (root) =>
-      Effect.gen(function* () {
-        const baseDir = NodePath.join(root, "missing-t3-home");
+    withTempDirectory("goat-app-platform-test-", (root) =>
+      Effect.gen(function* () {
+        const baseDir = NodePath.join(root, "missing-goat-home");
         const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
           Effect.provideService(HostProcess.Platform, "freebsd"),
           Effect.flip,
@@ -236,7 +236,7 @@
         expect(error).toMatchObject({
           _tag: "DesktopAppPlatformUnsupportedError",
           platform: "freebsd",
-          message: "`t3 app` is not supported on freebsd.",
+          message: "`goat app` is not supported on freebsd.",
         });
         expect(yield* pathExists(baseDir)).toBe(false);
       }),
@@ -244,9 +244,9 @@
   );

   it.effect("does not create state when only a server or no desktop app is running", () =>
-    withTempDirectory("t3-app-missing-test-", (root) =>
-      Effect.gen(function* () {
-        const baseDir = NodePath.join(root, "missing-t3-home");
+    withTempDirectory("goat-app-missing-test-", (root) =>
+      Effect.gen(function* () {
+        const baseDir = NodePath.join(root, "missing-goat-home");
         const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

         expect(error).toMatchObject({
@@ -262,9 +262,9 @@
   );

   it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
-    withTempDirectory("t3-app-command-test-", (root) =>
-      Effect.gen(function* () {
-        const baseDir = NodePath.join(root, "t3-home");
+    withTempDirectory("goat-app-command-test-", (root) =>
+      Effect.gen(function* () {
+        const baseDir = NodePath.join(root, "goat-home");
         const explicitPath = NodePath.join(root, "project");
         const platform = yield* HostProcess.Platform;
         const workingDirectory = yield* HostProcess.WorkingDirectory;
@@ -283,7 +283,7 @@
   );

   it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
-    withTempDirectory("t3-app-preferred-test-", (root) =>
+    withTempDirectory("goat-app-preferred-test-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, ".t3");
         const desktop = yield* fakeDesktop({ baseDir });
@@ -298,7 +298,7 @@
   );

   it.effect("finds the dev desktop when the default desktop socket is absent", () =>
-    withTempDirectory("t3-app-dev-test-", (root) =>
+    withTempDirectory("goat-app-dev-test-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, ".t3");
         const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });
@@ -313,7 +313,7 @@
   );

   it.effect("never searches a dev state directory for an explicit T3 home", () =>
-    withTempDirectory("t3-app-explicit-test-", (root) =>
+    withTempDirectory("goat-app-explicit-test-", (root) =>
       Effect.gen(function* () {
         const baseDir = NodePath.join(root, ".t3");
         const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });
@@ -331,7 +331,7 @@
   it.effect.each(["failure", "invalid"] as const)(
     "never falls back after the default desktop sends a %s response",
     (responseKind) =>
-      withTempDirectory("t3-app-response-test-", (root) =>
+      withTempDirectory("goat-app-response-test-", (root) =>
         Effect.gen(function* () {
           const baseDir = NodePath.join(root, ".t3");
           const desktop = yield* fakeDesktop({
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/pair.test.ts`

Expected help/error/command output follows goat; preserve npm runner expectations.

```diff
--- a/apps/server/src/cli/pair.test.ts
+++ b/apps/server/src/cli/pair.test.ts
@@ -144,11 +144,11 @@
     (server) => Effect.sync(() => server.close()),
   );

-describe("t3 pair", () => {
+describe("goat pair", () => {
   it.effect("mints a token and prints a QR pairing URL for a live server", () =>
     withDescriptorServer((origin) =>
       Effect.gen(function* () {
-        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
+        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-test-"));
         const port = Number(new URL(origin).port);
         const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
         yield* persistServerRuntimeState({
@@ -179,7 +179,7 @@
           readonly scopes: ReadonlyArray<string>;
         }>;
         assert.equal(credentials.length, 1);
-        assert.equal(credentials[0]?.label, "t3 pair");
+        assert.equal(credentials[0]?.label, "goat pair");
         assert.deepEqual(credentials[0]?.scopes, AuthStandardClientScopes);
       }),
     ).pipe(
@@ -203,7 +203,7 @@
   it.effect("mints a pairing grant with only the selected scopes", () =>
     withDescriptorServer((origin) =>
       Effect.gen(function* () {
-        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-scopes-test-"));
+        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-scopes-test-"));
         yield* persistServerRuntimeState({
           path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
           state: yield* makePersistedServerRuntimeState({
@@ -240,7 +240,7 @@
   it.effect("pairs through the recorded dev web URL for dev servers", () =>
     withDescriptorServer((origin) =>
       Effect.gen(function* () {
-        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-dev-test-"));
+        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-dev-test-"));
         const port = Number(new URL(origin).port);
         const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
         yield* persistServerRuntimeState({
@@ -258,9 +258,9 @@
     ).pipe(Effect.provide(NodeServices.layer)),
   );

-  it.effect("directs to t3 serve or t3 connect when no server is running", () =>
+  it.effect("directs to goat serve or goat connect when no server is running", () =>
     Effect.gen(function* () {
-      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-none-test-"));
+      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-none-test-"));

       const error = yield* provideCliTestLayers(
         runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
@@ -278,7 +278,7 @@
   it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
     withDescriptorServer((origin) =>
       Effect.gen(function* () {
-        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-pid-test-"));
+        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-pid-test-"));
         const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
         // The origin answers (another server reused the port), but the pid
         // that wrote this state file is dead — pairing must not mint a token
@@ -307,7 +307,7 @@

   it.effect("ignores stale runtime state pointing at a dead server", () =>
     Effect.gen(function* () {
-      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-stale-test-"));
+      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-pair-stale-test-"));
       const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
       // A port from the dynamic range with nothing listening: the probe fails
       // fast with ECONNREFUSED and discovery moves on.
@@ -340,7 +340,7 @@
     ({ group, action }) =>
       Effect.gen(function* () {
         const baseDir = NodeFS.mkdtempSync(
-          NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-scopes-test-"),
+          NodePath.join(NodeOS.tmpdir(), "goat-cli-auth-scopes-test-"),
         );
         const output = yield* captureStdout(
           runCli([
@@ -390,7 +390,7 @@
       if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
         assert.fail(`Expected ShowHelp, got ${String(error)}`);
       }
-      assert.deepEqual(error.commandPath, ["t3", ...command]);
+      assert.deepEqual(error.commandPath, ["goat", ...command]);
       const scopeError = error.errors[0];
       if (scopeError?._tag !== "InvalidValue") {
         assert.fail(`Expected InvalidValue, got ${String(scopeError?._tag)}`);
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/service.test.ts`

Expected help/error/command output follows goat; preserve npm runner expectations.

```diff
--- a/apps/server/src/cli/service.test.ts
+++ b/apps/server/src/cli/service.test.ts
@@ -35,7 +35,7 @@
     formatServiceStatus(status, "0.0.29"),
     [
       "T3 Code service",
-      "  Status: installed · t3@0.0.29",
+      "  Status: installed · goat@0.0.29",
       "  Unit: /home/me/.config/systemd/user/t3code.service",
       "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
     ].join("\n"),
@@ -45,7 +45,7 @@
 it("gives a direct repair command for a stale service", () => {
   assert.include(
     formatServiceStatus({ ...status, current: false }, "0.0.29"),
-    "Next: Run `t3 service install` to repair it.",
+    "Next: Run `goat service install` to repair it.",
   );
 });

@@ -64,7 +64,7 @@
   expect(output).toContain("last login session ends");
   expect(output).toContain('sudo loginctl enable-linger "$(id -un)"');
   expect(output).toContain("[service-stopped]");
-  expect(output).toContain("Run `t3 service install` to repair it.");
+  expect(output).toContain("Run `goat service install` to repair it.");
   expect(output).not.toContain("npx");
 });

@@ -73,7 +73,7 @@
     { ...status, current: false, installedVersion: "0.0.28" },
     "0.0.29",
   );
-  expect(output).toContain("Run `t3 service install` to repair it.");
+  expect(output).toContain("Run `goat service install` to repair it.");
   expect(output).not.toContain("npx");
 });

@@ -90,8 +90,8 @@
     "0.0.31",
   );

-  assert.include(output, "t3@0.0.32-nightly.1 (newer than this t3@0.0.31 CLI)");
-  assert.include(output, "Run `t3 update 0.0.32-nightly.1` to match it");
+  assert.include(output, "goat@0.0.32-nightly.1 (newer than this goat@0.0.31 CLI)");
+  assert.include(output, "Run `goat update 0.0.32-nightly.1` to match it");
   assert.notInclude(output, "npx");
 });

@@ -110,8 +110,8 @@
       Effect.sync(() => {
         installOptions.push(options);
         return {
-          program: ["/test/t3/runtime/versions/1.0.0/t3", "__service-launcher"],
-          baseDir: "/test/t3",
+          program: ["/test/goat/runtime/goat/versions/1.0.0/goat", "__service-launcher"],
+          baseDir: "/test/goat",
           unitPath: serviceStatus.unitPath,
           logPath: serviceStatus.logPath,
         };
@@ -125,7 +125,7 @@
   it.effect("restart restarts the installed service", () =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
-      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
+      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-cli-test-" });
       const { service, installOptions, restarts } = makeTestService(status);
       vi.spyOn(BootService, "layer").mockReturnValue(
         Layer.succeed(BootService.BootService, service),
@@ -150,7 +150,7 @@
     (command) =>
       Effect.gen(function* () {
         const fs = yield* FileSystem.FileSystem;
-        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
+        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-cli-test-" });
         const { service, installOptions } = makeTestService(newerServiceStatus);
         vi.spyOn(BootService, "layer").mockReturnValue(
           Layer.succeed(BootService.BootService, service),
@@ -178,7 +178,7 @@
   it.effect.each(["install", "update"] as const)("%s allows an explicit downgrade", (command) =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
-      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
+      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-cli-test-" });
       const { service, installOptions } = makeTestService(newerServiceStatus);
       vi.spyOn(BootService, "layer").mockReturnValue(
         Layer.succeed(BootService.BootService, service),
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/preview/PreviewBrowserHost.test.ts`

Expected help/error/command output follows goat; preserve npm runner expectations.

```diff
--- a/apps/server/src/preview/PreviewBrowserHost.test.ts
+++ b/apps/server/src/preview/PreviewBrowserHost.test.ts
@@ -64,7 +64,7 @@
   return PreviewBrowserHost.diagnoseLaunchFailure({
     executable: "/home/me/.t3/tools/chrome-headless-shell/linux64/154/chrome-headless-shell",
     output: input.output,
-    setupCommand: "sudo t3 browser setup",
+    setupCommand: "sudo goat browser setup",
   }).pipe(
     Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
     Effect.provideService(HostProcess.Platform, input.platform),
@@ -81,7 +81,7 @@
         ldd: "",
       });
       expect(error?._tag).toBe("PreviewBrowserSandboxError");
-      expect(error?.message).toContain("Run `sudo t3 browser setup` on the host");
+      expect(error?.message).toContain("Run `sudo goat browser setup` on the host");
       expect(commands).toEqual([]);
     }),
   );
@@ -97,7 +97,7 @@
         _tag: "PreviewBrowserLibrariesError",
         libraries: ["libglib-2.0.so.0", "libnss3.so", "libX11.so.6"],
       });
-      expect(error?.message).toContain("Run `sudo t3 browser setup` on the host");
+      expect(error?.message).toContain("Run `sudo goat browser setup` on the host");
     }),
   );

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/web/src/components/ServerUpdateAction.test.tsx`

Expected help/error/command output follows goat; preserve npm runner expectations.

```diff
--- a/apps/web/src/components/ServerUpdateAction.test.tsx
+++ b/apps/web/src/components/ServerUpdateAction.test.tsx
@@ -167,19 +167,19 @@
       { kind: "npm-global", prefix: "/opt/node" },
       "npm install --global --prefix '/opt/node' t3@0.0.45",
       "Update command copied",
-      "then restart t3",
+      "then restart goat",
     ],
     [
       { kind: "npx" },
       "npx t3@0.0.45",
       "Relaunch command copied",
-      "This does not update an installed t3 command.",
+      "This does not update an installed goat command.",
     ],
     [
       undefined,
       "npx t3@0.0.45",
       "Relaunch command copied",
-      "This does not update an installed t3 command.",
+      "This does not update an installed goat command.",
     ],
   ] satisfies ReadonlyArray<readonly [ServerInstallation | undefined, string, string, string]>)(
     "copies an honest manual command for %j without invoking remote update",
@@ -218,7 +218,7 @@
     expect(testState.toast).toHaveBeenCalledWith({
       type: "success",
       title: "Test server updated",
-      description: "Reconnected on t3@0.0.31.",
+      description: "Reconnected on goat@0.0.31.",
     });
   });

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/invocation.test.ts`

Legacy npm ownership + new goat native bin ownership; version mismatch fails closed and foreign t3 survives.

```diff
--- a/apps/server/src/cli/invocation.test.ts
+++ b/apps/server/src/cli/invocation.test.ts
@@ -47,7 +47,7 @@
   ]) {
     assert.equal(
       formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
-      "t3 serve",
+      "goat serve",
     );
   }
 });
@@ -93,7 +93,7 @@
       entryPath: "/usr/local/lib/node_modules/t3/dist/bin.mjs",
       version: "0.0.31-nightly.20260729",
     }),
-    "t3 serve",
+    "goat serve",
   );
 });

@@ -119,7 +119,7 @@
     const fs = yield* FileSystem.FileSystem;
     const path = yield* Path.Path;
     const bin = yield* fs.makeTempDirectoryScoped();
-    yield* fs.writeFileString(path.join(bin, "t3"), "#!/bin/sh\n", { mode: 0o755 });
+    yield* fs.writeFileString(path.join(bin, "goat"), "#!/bin/sh\n", { mode: 0o755 });
     return bin;
   });

@@ -140,7 +140,7 @@
           entry: "/home/theo/.local/lib/node_modules/t3/dist/bin.mjs",
           path: yield* pathWithT3,
         }),
-      ).toBe('sudo env "PATH=$PATH" t3 browser setup');
+      ).toBe('sudo env "PATH=$PATH" goat browser setup');
     }).pipe(Effect.scoped),
   );

@@ -149,7 +149,7 @@
       const fs = yield* FileSystem.FileSystem;
       const path = yield* Path.Path;
       const home = yield* fs.makeTempDirectoryScoped();
-      const shim = path.join(home, ".local bin", "t3");
+      const shim = path.join(home, ".local bin", "goat");
       yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
       yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
       const desktop = {
@@ -161,7 +161,7 @@
       expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);
       // A `t3` the person put on PATH still wins.
       expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
-        'sudo env "PATH=$PATH" t3 browser setup',
+        'sudo env "PATH=$PATH" goat browser setup',
       );
       // A standalone binary names itself.
       expect(
@@ -171,10 +171,10 @@
           executable: true,
         }),
       ).toBe("sudo /opt/t3/t3 browser setup");
-      // A stale shim path, then no launcher at all, fall back to plain `t3`.
+      // A stale shim path, then no launcher at all, fall back to plain `goat`.
       expect(
         yield* rootCommand({ ...desktop, env: { T3CODE_CLI_PATH: path.join(home, "gone") } }),
-      ).toBe('sudo env "PATH=$PATH" t3 browser setup');
+      ).toBe('sudo env "PATH=$PATH" goat browser setup');
     }).pipe(Effect.scoped),
   );
 });
@@ -269,6 +269,40 @@
         );
         expect(yield* resolve).toEqual(expected);
       }
+    }),
+  );
+
+  it.effect("proves the goat bin without claiming an unrelated t3 command", () =>
+    Effect.gen(function* () {
+      const fs = yield* FileSystem.FileSystem;
+      const path = yield* Path.Path;
+      const prefix = yield* fs.makeTempDirectoryScoped();
+      const packageRoot = path.join(prefix, "lib/node_modules/t3");
+      const launcher = path.join(packageRoot, "bin/t3.js");
+      const entry = path.join(packageRoot, "node_modules/@t3code/t3-linux-x64/goat");
+      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
+      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
+      yield* fs.makeDirectory(path.join(prefix, "bin"));
+      yield* fs.writeFileString(launcher, "");
+      yield* fs.writeFileString(entry, "");
+      yield* fs.writeFileString(path.join(packageRoot, "package.json"),
+        '{"name":"t3","version":"0.0.45","bin":{"goat":"./bin/t3.js","t3":"./bin/t3.js"},"optionalDependencies":{"@t3code/t3-linux-x64":"0.0.45"}}');
+      yield* fs.writeFileString(path.join(path.dirname(entry), "package.json"),
+        '{"name":"@t3code/t3-linux-x64","version":"0.0.45"}');
+      const foreign = path.join(prefix, "bin/t3");
+      yield* fs.writeFileString(foreign, "upstream command\n");
+      const resolve = resolveServerInstallation.pipe(
+        Effect.provideService(HostProcess.ExecutablePath, entry),
+        Effect.provideService(HostProcess.IsExecutable, true),
+        Effect.provideService(HostProcess.Platform, "linux"),
+      );
+      expect(yield* resolve).toBeNull();
+      yield* fs.symlink(launcher, path.join(prefix, "bin/goat"));
+      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
+      expect(yield* fs.readFileString(foreign)).toBe("upstream command\n");
+      yield* fs.writeFileString(path.join(path.dirname(entry), "package.json"),
+        '{"name":"@t3code/t3-linux-x64","version":"0.0.44"}');
+      expect(yield* resolve).toBeNull();
     }),
   );

```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install.test.ts`

Real POSIX installer repairs marker-only GOAT cache, executes goat shim, preserves upstream same-version cache; HTTP failure/progress semantics remain tested.

```diff
--- a/scripts/install.test.ts
+++ b/scripts/install.test.ts
@@ -15,13 +15,13 @@
     async (fail) => {
       const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
       const version = "1.2.3";
-      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
+      const stem = `goat-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
       const archiveName = `${stem}.tar.gz`;
       let resumeDownload: (() => void) | undefined;
       let sawPartialProgress = false;
       let output = "";
       await NodeFSP.mkdir(NodePath.join(root, stem));
-      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
+      await NodeFSP.writeFile(NodePath.join(root, stem, "goat"), "#!/bin/sh\necho 'goat v1.2.3'\n", {
         mode: 0o755,
       });
       await NodeFSP.writeFile(
@@ -55,6 +55,15 @@
         "'",
         "'\\''",
       );
+      const upstream = NodePath.join(root, "home/runtime/versions", version);
+      if (!fail) {
+        await NodeFSP.mkdir(upstream, { recursive: true });
+        await NodeFSP.writeFile(NodePath.join(upstream, "t3"), "upstream runtime\n");
+        await NodeFSP.writeFile(NodePath.join(upstream, ".install-complete"), version);
+        const incomplete = NodePath.join(root, "home/runtime/goat/versions", version);
+        await NodeFSP.mkdir(incomplete, { recursive: true });
+        await NodeFSP.writeFile(NodePath.join(incomplete, ".install-complete"), version);
+      }
       const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
         env: {
           ...process.env,
@@ -81,28 +90,30 @@
           child.on("error", reject);
           child.on("close", resolve);
         });
-        const versions = NodePath.join(root, "home/runtime/versions");
+        const versions = NodePath.join(root, "home/runtime/goat/versions");
         if (fail) {
           expect(code).not.toBe(0);
           expect(output).toContain("500");
           expect(output).not.toContain("100%");
-          expect(output).not.toContain("Installed T3 Code");
+          expect(output).not.toContain("Installed GOAT");
           expect(await NodeFSP.readdir(versions)).toEqual([]);
         } else {
           expect(code).toBe(0);
           expect(sawPartialProgress).toBe(true);
           expect(output).toContain("100%");
           expect(output).toContain("0.1 / 0.1 MB");
-          expect(output).toContain("Installed T3 Code 1.2.3");
+          expect(output).toContain("Installed GOAT 1.2.3");
           expect(
             await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
           ).toBe("1.2.3\n");
           expect(
-            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
+            NodeChildProcess.execFileSync(NodePath.join(root, "bin/goat"), ["--version"], {
               encoding: "utf8",
             }).trim(),
-          ).toBe("t3 v1.2.3");
+          ).toBe("goat v1.2.3");
           expect(await NodeFSP.readdir(versions)).toEqual([version]);
+          expect(await NodeFSP.readFile(NodePath.join(upstream, "t3"), "utf8")).toBe("upstream runtime\n");
+          expect(await NodeFSP.readFile(NodePath.join(upstream, ".install-complete"), "utf8")).toBe(version);
         }
       } finally {
         if (child.exitCode === null) child.kill();
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/fixtures/remote-runner-baseline.json`

Frozen runner/launch/pairing bytes change deliberately with executable/runtime namespace. This includes node override variants because wrapper script still embeds archive fallback.

```diff
--- a/packages/ssh/src/fixtures/remote-runner-baseline.json
+++ b/packages/ssh/src/fixtures/remote-runner-baseline.json
@@ -1,17 +1,17 @@
 {
   "archive": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   },
   "mirror": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   },
   "node": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=0\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No t3 release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `t3 service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/t3\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another t3 %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no t3 release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/t3\" --version >/dev/null 2>&1; then\n    printf 'The t3 %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/t3\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=0\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   }
 }
```

### MODIFY `docs/user/install.md`, `docs/user/background-service.md`, `docs/user/remote-access.md`

The planned diffs for these three guides nested code fences inside a diff fence, and a later
formatting pass split them apart, so the excerpt no longer read as one patch. The changes that
landed are in the history of those files:

```sh
git log -p -- docs/user/install.md docs/user/background-service.md docs/user/remote-access.md
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/welcome-wizard.md`

Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.

```diff
--- a/docs/user/welcome-wizard.md
+++ b/docs/user/welcome-wizard.md
@@ -13,13 +13,13 @@
 You can add more computers before continuing:

 - **T3 Connect** connects computers that are signed in to your account.
-  [Install the CLI](./install.md#command-line) and run `t3 connect` on each
-  computer you want to add, then start T3 Code or run `t3 serve` so the
+  [Install the CLI](./install.md#command-line) and run `goat connect` on each
+  computer you want to add, then start T3 Code or run `goat serve` so the
   computer stays available.
 - **Add a computer** connects directly to a server on your network or tailnet.
-  Start the server with `t3 serve`, then run `t3 pair --tailscale` and paste
-  the pairing link. You can also run `t3 serve --host <address>` and use
-  `t3 pair` when the server is already reachable on your network.
+  Start the server with `goat serve`, then run `goat pair --tailscale` and paste
+  the pairing link. You can also run `goat serve --host <address>` and use
+  `goat pair` when the server is already reachable on your network.

 Saved computers and computers discovered through T3 Connect are selected by
 default. Uncheck any you do not want to set up; this does not disconnect them.
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/user/updating.md`

Rewrite existing standalone/desktop usage to goat; preserve npx t3 and upstream store/package-manager ids.

````diff
--- a/docs/user/updating.md
+++ b/docs/user/updating.md
@@ -45,21 +45,21 @@
 | **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
 | **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
 | **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
-| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |
+| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `goat` command.                       |

 On the host, run:

 ```sh
-t3 update <client-version>
+goat update <client-version>
````

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
\-`t3 service restart` when you are ready. For a server you started by hand, +`goat service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

-If you run the server with `npx` rather than an installed `t3`, there is
+If you run the server with `npx` rather than an installed `goat`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

````

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/docs/operations/release.md`

Document archive/executable and dual-bin contract in existing operational guidance; package publishing identity stays unchanged.

```diff
--- a/docs/operations/release.md
+++ b/docs/operations/release.md
@@ -14,7 +14,7 @@
   - push tag matching `v*.*.*` for a stable release of an explicit commit
   - scheduled nightly check every 30 minutes
   - manual `workflow_dispatch` with `channel=nightly`
-  - manual `workflow_dispatch` with `channel=preview`, the maintainers' test train. It exercises the whole release flow (build, sign, notarize, smoke, publish) for a commit that end users must never receive, which is how an unmerged branch or a risky change gets a real release run before it lands. It builds the triggering commit with nightly's versioning under the `preview` prerelease identifier (`0.0.41-preview.<date>.<run>`) and publishes a GitHub prerelease plus the npm packages under the `preview` dist-tag. Preview is not on the schedule, no default npm dist-tag points at it, its desktop builds carry no update feed, and no updater manifest (`latest*.yml`, `nightly*.yml`, blockmaps) is attached, so a stable or nightly install cannot be offered one. The only ways onto it are downloading the release by hand, `npx t3@preview`, `T3CODE_CHANNEL=preview` for the install scripts, or `t3 update --channel preview` from a terminal; each prints a warning, and the CLI asks for confirmation when the running build is not itself a preview. The release itself is named as a maintainer test build and its body is a warning rather than generated notes: a changelog of unmerged branch history is not a changelog, and nightly and stable notes are unaffected because each series resolves its previous tag within its own channel. The hosted web app, AUR, and Discord announcements are skipped. Keep it; it costs nothing when idle.
+  - manual `workflow_dispatch` with `channel=preview`, the maintainers' test train. It exercises the whole release flow (build, sign, notarize, smoke, publish) for a commit that end users must never receive, which is how an unmerged branch or a risky change gets a real release run before it lands. It builds the triggering commit with nightly's versioning under the `preview` prerelease identifier (`0.0.41-preview.<date>.<run>`) and publishes a GitHub prerelease plus the npm packages under the `preview` dist-tag. Preview is not on the schedule, no default npm dist-tag points at it, its desktop builds carry no update feed, and no updater manifest (`latest*.yml`, `nightly*.yml`, blockmaps) is attached, so a stable or nightly install cannot be offered one. The only ways onto it are downloading the release by hand, `npx t3@preview`, `T3CODE_CHANNEL=preview` for the install scripts, or `goat update --channel preview` from a terminal; each prints a warning, and the CLI asks for confirmation when the running build is not itself a preview. The release itself is named as a maintainer test build and its body is a warning rather than generated notes: a changelog of unmerged branch history is not a changelog, and nightly and stable notes are unaffected because each series resolves its previous tag within its own channel. The hosted web app, AUR, and Discord announcements are skipped. Keep it; it costs nothing when idle.
 - A manual stable release builds the commit of the latest published nightly, not `main` HEAD.
   Nightly is the release candidate: verify the nightly, then promote it. Merges to `main` keep
   landing while you verify and never leak into the stable build.
@@ -37,12 +37,12 @@
   - Nightly runs are always GitHub prereleases and never marked latest.
   - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
 - Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
-- Builds a self-contained CLI archive per platform (`t3-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) in the same job as that target's desktop artifact and attaches them to the GitHub Release with a `SHA256SUMS` file, on every channel, for five targets: macOS arm64, Linux x64 and arm64, Windows x64 and arm64. Every archive is built, signed, and smoke-tested on hardware of its own architecture. There is no macOS x64 archive: Node single-executables are unsupported on x64 macOS (the SEA docs list macOS as arm64 only) and the binary segfaults on start; the x64 desktop app is Electron and unaffected.
-  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so unpacking it needs neither Node, npm, nor a compiler. It is the only form in which T3 Code manages a runtime: the desktop's SSH environments, the boot service, `t3 update`, and the install scripts all download and verify this archive against `SHA256SUMS`. The npm packages exist for people who run `npx t3` or `npm install -g t3` themselves and carry the same archive contents; nothing in the product installs from npm. The `curl | sh` installers are `scripts/install.sh` and `scripts/install.ps1`; the marketing site copies them into its `public/` at build time (`apps/marketing/scripts/stage-install-scripts.mjs`) and serves them at `t3.codes/install.sh` and `/install.ps1`.
+- Builds a self-contained CLI archive per platform (`goat-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) in the same job as that target's desktop artifact and attaches them to the GitHub Release with a `SHA256SUMS` file, on every channel, for five targets: macOS arm64, Linux x64 and arm64, Windows x64 and arm64. Every archive is built, signed, and smoke-tested on hardware of its own architecture. There is no macOS x64 archive: Node single-executables are unsupported on x64 macOS (the SEA docs list macOS as arm64 only) and the binary segfaults on start; the x64 desktop app is Electron and unaffected.
+  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so unpacking it needs neither Node, npm, nor a compiler. It is the only form in which T3 Code manages a runtime: the desktop's SSH environments, the boot service, `goat update`, and the install scripts all download and verify this archive against `SHA256SUMS`. The npm packages exist for people who run `npx t3` or `npm install -g t3` themselves and carry the same archive contents; nothing in the product installs from npm. The `curl | sh` installers are `scripts/install.sh` and `scripts/install.ps1`; the marketing site copies them into its `public/` at build time (`apps/marketing/scripts/stage-install-scripts.mjs`) and serves them at `t3.codes/install.sh` and `/install.ps1`.
   - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`, kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
   - macOS archives are signed with the Developer ID certificate and notarized when the Apple secrets are present (ad hoc otherwise, which still runs from `curl`/`tar` installs). Windows executables use the same Azure Trusted Signing setup as the installer. Every native addon in the macOS archive is signed too, since the hardened runtime refuses unsigned libraries.
   - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`) before it is uploaded.
-- Publishes the CLI to npm with OIDC trusted publishing from the same workflow file, as the same bytes the GitHub Release carries: `scripts/build-npm-platform-packages.ts` unpacks the five CLI archives into `@t3code/t3-<platform>-<arch>` packages (each with `os`/`cpu` set so npm installs only the matching one) and generates the `t3` launcher, whose `bin/t3.js` lists them as `optionalDependencies` and execs the installed executable. `npx t3` therefore needs Node only to run the launcher, never to run the server. `node apps/server/scripts/cli.ts publish` publishes the platform packages first and the launcher last, after a `--dry-run` pass over all of them so an auth or scope error fails before anything is live.
+- Publishes the CLI to npm with OIDC trusted publishing from the same workflow file, as the same bytes the GitHub Release carries: `scripts/build-npm-platform-packages.ts` unpacks the five CLI archives into `@t3code/t3-<platform>-<arch>` packages (each with `os`/`cpu` set so npm installs only the matching one) and generates the `t3` launcher, whose `bin/t3.js` lists them as `optionalDependencies` and exposes both `goat` and `t3` bins and execs the installed `goat` executable. `npx t3` therefore needs Node only to run the launcher, never to run the server. `node apps/server/scripts/cli.ts publish` publishes the platform packages first and the launcher last, after a `--dry-run` pass over all of them so an auth or scope error fails before anything is live.
   - stable releases publish npm dist-tag `latest`
   - nightly releases publish npm dist-tag `nightly`
   - preview releases publish npm dist-tag `preview`, which nothing resolves unless asked for by name
@@ -421,7 +421,7 @@
 paths below `resources/server.asar.unpacked`. The Windows-native backend reads
 the archive in place through Electron. Packaged Windows builds also ship
 `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
-(`t3-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
+(`goat-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built
 by the Linux desktop job and handed to the Windows desktop build as
 `--wsl-runtime`, copied in verbatim so WSL runs the exact bytes a Linux user
 downloads. WSL verifies and extracts that archive
@@ -445,7 +445,7 @@
 - A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
   sidecar, or the sidecar digest does not match the emitted archive.
 - The emitted WSL archive is not a Linux CLI release archive: it must unpack to
-  a single `t3-<version>-linux-<arch>` directory holding `t3`, `client/`, and
+  a single `goat-<version>-linux-<arch>` directory holding `goat`, `client/`, and
   `node_modules/` with the Linux node-pty binary, and must not carry a loose
   server bundle (`bin.mjs`).
 - The external Windows resource monitor is absent.
````

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/runtimeArchive.test.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/packages/ssh/src/runtimeArchive.test.ts
+++ b/packages/ssh/src/runtimeArchive.test.ts
@@ -13,7 +13,7 @@
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
       const root = yield* fs.makeTempDirectoryScoped();
-      yield* fs.writeFile(`${root}/t3-1.2.3-linux-x64.tar.gz`, new Uint8Array([0, 128, 255]));
+      yield* fs.writeFile(`${root}/goat-1.2.3-linux-x64.tar.gz`, new Uint8Array([0, 128, 255]));
       const archive = yield* readLocalRuntimeArchive(root, "1.2.3", "linux-x64");
       assert.isNotNull(archive);
       assert.deepEqual(archive?.bytes, new Uint8Array([0, 128, 255]));
@@ -38,7 +38,7 @@
       Effect.gen(function* () {
         const fs = yield* FileSystem.FileSystem;
         const root = yield* fs.makeTempDirectoryScoped();
-        const file = `${root}/t3-1.2.3-linux-x64.tar.gz`;
+        const file = `${root}/goat-1.2.3-linux-x64.tar.gz`;
         yield* fs.writeFile(file, new Uint8Array([0]));
         const info = yield* fs.stat(file);
         let reads = 0;
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/selfUpdate.test.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/apps/server/src/cloud/selfUpdate.test.ts
+++ b/apps/server/src/cloud/selfUpdate.test.ts
@@ -40,7 +40,7 @@
         ).join("");
         return HttpClientResponse.fromWeb(
           request,
-          new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\n`),
+          new Response(`${hex}  goat-1.1.0-linux-x64.tar.gz\n`),
         );
       }
       order.push("download");
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/bootService.test.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/apps/server/src/cloud/bootService.test.ts
+++ b/apps/server/src/cloud/bootService.test.ts
@@ -20,7 +20,7 @@
   serviceStateHasPendingUpdate,
 } from "./serviceProtocol.ts";

-const linuxRuntime = "/home/theo/.t3/runtime/versions/1.2.3/t3";
+const linuxRuntime = "/home/theo/.t3/runtime/goat/versions/1.2.3/goat";
 const linuxPlan = {
   program: [linuxRuntime, "__service-launcher"],
   baseDir: "/home/theo/.t3",
@@ -38,7 +38,7 @@

 it("reads the served T3 home back out of a rendered unit or plist", () => {
   const plan = (baseDir: string) => ({
-    program: [`${baseDir}/runtime/versions/1.2.3/t3`, "__service-launcher"],
+    program: [`${baseDir}/runtime/goat/versions/1.2.3/goat`, "__service-launcher"],
     baseDir,
     logPath: `${baseDir}/userdata/logs/boot-service.log`,
     unitPath: "/home/theo/.config/systemd/user/t3code.service",
@@ -70,7 +70,7 @@
   expect(unit).toContain("OOMPolicy=continue");
 });

-const macRuntime = "/Users/theo/.t3/runtime/versions/1.2.3/t3";
+const macRuntime = "/Users/theo/.t3/runtime/goat/versions/1.2.3/goat";
 const macPlan = {
   program: [macRuntime, "__service-launcher"],
   baseDir: "/Users/theo/.t3",
@@ -216,7 +216,7 @@
         baseDir: serviceBaseDir,
         logsDir: path.join(serviceBaseDir, "userdata", "logs"),
         cliVersion,
-        host: { execPath: "/usr/bin/t3" },
+        host: { execPath: "/usr/bin/goat" },
       });
     }).pipe(
       Effect.provideService(ProcessRunner.ProcessRunner, runner),
@@ -224,7 +224,7 @@
         Layer.mergeAll(
           Layer.succeed(HostProcess.Platform, platform),
           Layer.succeed(HostProcess.UserId, 501),
-          Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/t3"),
+          Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/goat"),
           Layer.succeed(
             HttpClient.HttpClient,
             HttpClient.make(() => Effect.die("no release download expected")),
@@ -497,14 +497,14 @@
         protocol: SERVICE_LAUNCHER_PROTOCOL,
         activeVersion: "1.2.4",
       });
-      expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/t3");
+      expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/goat");
       expect(
         commands.filter(
           (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
         ),
       ).toEqual([]);
       // The files say 1.2.4 but the process is still 1.2.3: not current, and
-      // the reason is named so `t3 service status` can point at restart.
+      // the reason is named so `goat service status` can point at restart.
       const status = yield* newer.status;
       expect(status.current).toBe(false);
       expect(status.problems).toContain("restart-pending");
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/relayResponse.test.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/apps/server/src/cloud/relayResponse.test.ts
+++ b/apps/server/src/cloud/relayResponse.test.ts
@@ -71,7 +71,7 @@

     expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unauthorized" });
     expect(error.message).toContain("invalid_bearer");
-    expect(error.message).toContain("t3 connect login");
+    expect(error.message).toContain("goat connect login");
     expect(error.message).toContain("Trace ID: trace-auth");
   }),
 );
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cloud/serviceLauncherClient.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/apps/server/src/cloud/serviceLauncherClient.ts
+++ b/apps/server/src/cloud/serviceLauncherClient.ts
@@ -34,7 +34,7 @@
       case "decode-context":
         return "The service launcher supplied invalid startup context.";
       case "version-mismatch":
-        return "The service launcher started a different t3 version.";
+        return "The service launcher started a different goat version.";
       case "ipc-unavailable":
         return "The service launcher IPC channel is unavailable.";
       case "unmanaged":
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/cli/server.ts`

Follow renamed archive/runtime/help through existing behavioral consumer or fixture; no package/protocol identity change.

```diff
--- a/apps/server/src/cli/server.ts
+++ b/apps/server/src/cli/server.ts
@@ -45,7 +45,7 @@
       ) {
         return yield* new CliError.UserError({
           cause: cwd,
-          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
+          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "goat --help" for commands or an explicit path such as "goat ./my-project" for a new directory.`,
         });
       }
     }
```

### NEW `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/scripts/install-windows.test.ts`

Real Windows installer/HTTP/ZIP, marker-only/broken/runnable cache, goat.cmd invocation, upstream preservation; explicit non-Windows skip.

```diff
--- a/scripts/install-windows.test.ts
+++ b/scripts/install-windows.test.ts
@@ -0,0 +1,76 @@
+// @effect-diagnostics nodeBuiltinImport:off - Drives the real Windows installer against a local release fixture.
+import * as NodeChildProcess from "node:child_process";
+import * as NodeCrypto from "node:crypto";
+import * as NodeFSP from "node:fs/promises";
+import * as NodeHttp from "node:http";
+import * as NodeOS from "node:os";
+import * as NodePath from "node:path";
+import { promisify } from "node:util";
+import { describe, expect, it } from "vite-plus/test";
+
+const execFile = promisify(NodeChildProcess.execFile);
+const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
+const powershell = (command: string, env: NodeJS.ProcessEnv = process.env) =>
+  execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { env, timeout: 90_000 });
+
+describe.skipIf(process.platform !== "win32")("Windows archive installer", () => {
+  it("repairs marker-only/broken entries, reuses a runnable cache and preserves upstream t3", async () => {
+    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-install-"));
+    let server: NodeHttp.Server | undefined;
+    try {
+      const version = "1.2.3";
+      const stem = `goat-${version}-win32-${process.arch}`;
+      const stage = NodePath.join(root, stem);
+      await NodeFSP.mkdir(stage);
+      // A real native executable exercises --version without claiming SEA-build proof.
+      await NodeFSP.copyFile(process.execPath, NodePath.join(stage, "goat.exe"));
+      const zip = NodePath.join(root, `${stem}.zip`);
+      await powershell(`Compress-Archive -LiteralPath ${ps(stage)} -DestinationPath ${ps(zip)}`);
+      const bytes = await NodeFSP.readFile(zip);
+      const checksum = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
+      let archiveRequests = 0;
+      server = NodeHttp.createServer((request, response) => {
+        if (request.url === `/v${version}/SHA256SUMS`) response.end(`${checksum}  ${stem}.zip\n`);
+        else if (request.url === `/v${version}/${stem}.zip`) { archiveRequests += 1; response.end(bytes); }
+        else response.writeHead(404).end();
+      });
+      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
+      const address = server.address();
+      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
+      for (const cache of ["marker-only", "broken", "ready"] as const) {
+        const home = NodePath.join(root, `home ${cache}`);
+        const bin = NodePath.join(root, `bin ${cache}`);
+        const upstream = NodePath.join(home, "runtime", "versions", version);
+        const target = NodePath.join(home, "runtime", "goat", "versions", version);
+        await NodeFSP.mkdir(upstream, { recursive: true });
+        await NodeFSP.mkdir(target, { recursive: true });
+        await NodeFSP.mkdir(bin, { recursive: true });
+        await NodeFSP.writeFile(NodePath.join(upstream, "t3.exe"), "upstream runtime");
+        await NodeFSP.writeFile(NodePath.join(upstream, ".install-complete"), version);
+        await NodeFSP.writeFile(NodePath.join(bin, "t3.cmd"), "upstream launcher");
+        await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), version);
+        if (cache === "broken") await NodeFSP.writeFile(NodePath.join(target, "goat.exe"), "not an executable");
+        if (cache === "ready") await NodeFSP.copyFile(process.execPath, NodePath.join(target, "goat.exe"));
+        const before = archiveRequests;
+        await powershell(`& ${ps(NodePath.join(import.meta.dirname, "install.ps1"))}`, {
+          ...process.env,
+          T3CODE_VERSION: version, T3CODE_CHANNEL: "stable", T3CODE_HOME: home,
+          T3CODE_INSTALL_BIN_DIR: bin, T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
+        });
+        expect(archiveRequests - before).toBe(cache === "ready" ? 0 : 1);
+        expect((await NodeFSP.readFile(NodePath.join(target, ".install-complete"), "utf8")).trim()).toBe(version);
+        const result = await powershell(`& ${ps(NodePath.join(bin, "goat.cmd"))} --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
+        expect(result.stdout.trim()).toBe(process.version);
+        expect(await NodeFSP.readFile(NodePath.join(upstream, "t3.exe"), "utf8")).toBe("upstream runtime");
+        expect(await NodeFSP.readFile(NodePath.join(upstream, ".install-complete"), "utf8")).toBe(version);
+        expect(await NodeFSP.readFile(NodePath.join(bin, "t3.cmd"), "utf8")).toBe("upstream launcher");
+      }
+    } finally {
+      if (server) {
+        server.closeAllConnections();
+        await new Promise<void>((resolve) => server!.close(() => resolve()));
+      }
+      await NodeFSP.rm(root, { recursive: true, force: true });
+    }
+  }, 120_000);
+});
```

### MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/.github/workflows/web-preview.yml`

Preview deployment output and workflow guidance name the standalone goat pairing command; hosted preview execution/publishing is not authorized.

```diff
--- a/.github/workflows/web-preview.yml
+++ b/.github/workflows/web-preview.yml
@@ -7,7 +7,7 @@
 #
 # The build intentionally omits the T3 Connect cloud config (Clerk keys, relay
 # URL): previews boot as the hosted-static app with manual pairing only. Pair a
-# server into a preview with `t3 pair --tailscale` (or any reachable HTTPS
+# server into a preview with `goat pair --tailscale` (or any reachable HTTPS
 # backend) and open the pairing URL against the preview origin.
 #
 # The preview must be opened at the exact deployment URL from the PR comment.
@@ -103,7 +103,7 @@
               `${process.env.DEPLOYMENT_URL} (for ${process.env.HEAD_SHA.slice(0, 7)})`,
               "",
               "Open this exact URL — the hosted-app origin is baked in at build time.",
-              "Pair a server into it with `t3 pair --tailscale`, or paste a host + pairing",
+              "Pair a server into it with `goat pair --tailscale`, or paste a host + pairing",
               "code under Settings → Connections.",
             ].join("\n");

```

## A11: preserved GOAT runner readiness (extend wp2's single probe)

Stale check @cd1dfd752: wp2 already implements retained-runner classification in `buildRemoteRuntimeProbeScript` (`packages/ssh/src/tunnel.ts:1059–1105`) and consumes its retained result before acquisition in `prepareRemoteRuntime` (`:1128–1167`). The retained-runner regression table is `packages/ssh/src/tunnel.test.ts:822–1004`. These anchors refer to the inspected source before this plan's projected changes.

Contract: with `keepExistingRunner` and a state key, the existing probe reads the preserved runner's `T3_NODE_SCRIPT_PATH` / `T3_ARCHIVE_VERSION` assignments without sourcing or executing it. Archive versions retain wp2's exact-version validation. Archive retained readiness requires executable presence and the matching `.install-complete` version at **`~/.goat/runtime/goat/versions/<retainedVersion>/goat`**. A ready older or unmarked GOAT runner is reused as wp2 specifies; its version need not equal the requesting client's version. Node-script runners retain wp2's ready classification. No GOAT script marker or new compatibility mechanism is introduced.

`retained: ready` returns before local-cache reads, gh download, mirror acquisition or upload and annotates `t3.runtime.source=retained-runner`. `retained: missing` raises the existing clear `SshLaunchError` before any acquisition, launch or MCP issuance, even with an explicit mirror. Preserve this branch ordering, the schema's optional `retained` / `retainedVersion` fields, `prepareRemoteRuntime(..., stateKey)`, its launch/MCP callers and `runner?.ghCommand`. No second SSH probe, install-alongside helper or forced same-version restart gate belongs in 030.

This A11 block moves the probe's runner lookup to `~/.goat/ssh-launch/<stateKey>/run-t3.sh` and its retained executable directly to D7-A's final root. The ordinary current-version probe and every other runner/home/state path finish their move in D7-A below. Apply core → A11 → D7-A as one unit; intermediate states are not runnable. Never import upstream `.t3` ownership/runtime data. Keep run-t3.sh and run-t3.next names and keepExistingRunner/leaveRemoteServerRunning behavior.

Pairing retains wp2's current-build preparation and existing runner replacement behavior: preparation receives no state key, unlike launch and MCP issuance. The existing `entry=pairing, mode=ready` regression therefore continues to expect probe → gh → upload → pairing. This leaf does not broaden retained-runner reuse to pairing or change that lifecycle. Its default server home still becomes `~/.goat` through D7-A.

Execution order remains wp2 → wp3 → **wp6 (`050_provider_key_goat.md`)** → wp4 (`030`) → wp5. 050 owns provider adapter changes; 030 contains no provider adapter hunks. Recheck later parent overlap without undoing wp2's goat-si/goat acquisition or wp3's goat MCP names.

### A11 exact hunks — tunnel.ts (relative to core after-state)

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@ -1065,7 +1065,7 @@
 V=${shellSingleQuote(version)}
 state_key=${shellSingleQuote(stateKey ?? "")}
 retained_fields=
-runner="$HOME/.t3/ssh-launch/$state_key/run-t3.sh"
+runner="$HOME/.goat/ssh-launch/$state_key/run-t3.sh"
 if [ "${keepExistingRunner ? "1" : "0"}" = 1 ] && [ -n "$state_key" ] && [ -f "$runner" ]; then
   node_script_path="$(sed -n "s/^T3_NODE_SCRIPT_PATH='\\(.*\\)'$/\\1/p" "$runner")"
   retained_version=
@@ -1078,8 +1078,8 @@
     if ! printf '%s\\n' "$retained_version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'; then
       printf 'The retained runner has an invalid exact archive version.\\n' >&2; exit 1
     fi
-    retained_runtime="$HOME/.t3/runtime/versions/$retained_version"
-    if [ ! -x "$retained_runtime/t3" ] || [ "$(cat "$retained_runtime/.install-complete" 2>/dev/null)" != "$retained_version" ]; then
+    retained_runtime="$HOME/.goat/runtime/goat/versions/$retained_version"
+    if [ ! -x "$retained_runtime/goat" ] || [ "$(cat "$retained_runtime/.install-complete" 2>/dev/null)" != "$retained_version" ]; then
       retained=missing
     fi
   fi
@@ -1161,7 +1161,7 @@
     }
     if (probe.retained === "missing") {
       return yield* new SshLaunchError({
-        message: `The retained runner ~/.t3/ssh-launch/${stateKey}/run-t3.sh selects t3 ${probe.retainedVersion}, which is not installed on ${target.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
+        message: `The retained runner ~/.goat/ssh-launch/${stateKey}/run-t3.sh selects goat ${probe.retainedVersion}, which is not installed on ${target.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
         stdout: "",
       });
     }
```

### A11 exact hunks — tunnel.test.ts (relative to core after-state)

Extend wp2's existing table and real-shell probe fixture. Ready covers an older retained version with no extra marker; missing, marker-only, non-executable and wrong-marker cases fail before cache/gh/upload, including explicit mirror configuration. Upstream-only seeds a runnable upstream t3 and matching marker under `.t3/runtime/versions`; it cannot satisfy GOAT readiness and its bytes survive. Existing invalid-version, node-mode, cold-start, pairing and managed-server cases remain. D7-A moves the remaining remote state/current-build paths together.

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -831,6 +831,14 @@
     { entry: "launch", mode: "invalid" },
     { entry: "mcp", mode: "invalid" },
     { entry: "pairing", mode: "ready" },
+    { entry: "launch", mode: "upstream-only" },
+    { entry: "mcp", mode: "upstream-only" },
+    { entry: "launch", mode: "marker-only" },
+    { entry: "mcp", mode: "marker-only" },
+    { entry: "launch", mode: "non-executable" },
+    { entry: "mcp", mode: "non-executable" },
+    { entry: "launch", mode: "wrong-marker" },
+    { entry: "mcp", mode: "wrong-marker" },
   ] as const)("$entry preparation with retained runtime=$mode", ({ entry, mode }) =>
     Effect.gen(function* () {
       const fs = yield* FileSystem.FileSystem;
@@ -848,12 +856,27 @@
         yield* fs.writeFileString(`${state}/run-t3.sh`, retainedScript);
         yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
       }
-      if (mode === "ready") {
-        const runtime = `${root}/.t3/runtime/goat/versions/${retainedVersion}`;
+      const retainedMissing = ["missing", "upstream-only", "marker-only", "non-executable", "wrong-marker"].some(
+        (value) => value === mode,
+      );
+      const upstream = `${root}/.t3/runtime/versions/${retainedVersion}`;
+      if (mode === "upstream-only") {
+        yield* fs.makeDirectory(upstream, { recursive: true });
+        yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n");
+        yield* fs.chmod(`${upstream}/t3`, 0o700);
+        yield* fs.writeFileString(`${upstream}/.install-complete`, retainedVersion);
+      }
+      if (mode === "ready" || mode === "marker-only" || mode === "non-executable" || mode === "wrong-marker") {
+        const runtime = `${root}/.goat/runtime/goat/versions/${retainedVersion}`;
         yield* fs.makeDirectory(runtime, { recursive: true });
-        yield* fs.writeFileString(`${runtime}/goat`, "#!/bin/sh\nexit 0\n");
-        yield* fs.chmod(`${runtime}/goat`, 0o700);
-        yield* fs.writeFileString(`${runtime}/.install-complete`, retainedVersion);
+        if (mode !== "marker-only") {
+          yield* fs.writeFileString(`${runtime}/goat`, "#!/bin/sh\nexit 0\n");
+          yield* fs.chmod(`${runtime}/goat`, mode === "non-executable" ? 0o600 : 0o700);
+        }
+        yield* fs.writeFileString(
+          `${runtime}/.install-complete`,
+          mode === "wrong-marker" ? ARCHIVE.archiveVersion : retainedVersion,
+        );
       }
       const archiveDirectory = `${root}/missing-cache`;
       const bytes = new Uint8Array([0, 128, 255]);
@@ -935,7 +958,7 @@
         ...ARCHIVE,
         archiveDirectory,
         keepExistingRunner: true,
-        ...(mode === "missing" ? { releaseBaseUrl: "https://mirror.example/goat" } : {}),
+        ...(retainedMissing ? { releaseBaseUrl: "https://mirror.example/goat" } : {}),
       };
       const invocation =
         entry === "launch"
@@ -976,14 +999,14 @@
         );
         assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), retainedScript);
         assert.isFalse(yield* fs.exists(archiveDirectory));
-      } else if (mode === "missing" || mode === "invalid") {
+      } else if (retainedMissing || mode === "invalid") {
         assert.isTrue(Result.isFailure(result));
         if (Result.isFailure(result)) {
           assert.instanceOf(result.failure, SshLaunchError);
-          if (mode === "missing") {
+          if (retainedMissing) {
             assert.equal(
               result.failure.message,
-              `The retained runner ~/.t3/ssh-launch/${stateKey}/run-t3.sh selects t3 ${retainedVersion}, which is not installed on ${uploadTarget.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
+              `The retained runner ~/.goat/ssh-launch/${stateKey}/run-t3.sh selects goat ${retainedVersion}, which is not installed on ${uploadTarget.alias}. This client reuses that runner and will not replace it; reconnect from the client that owns it, or remove the runner to let this client install its own runtime.`,
             );
           }
         }
@@ -991,6 +1014,10 @@
         assert.equal(cacheReads, 0);
         assert.isFalse(yield* fs.exists(archiveDirectory));
         assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), retainedScript);
+        if (mode === "upstream-only") {
+          assert.equal(yield* fs.readFileString(`${upstream}/t3`), "#!/bin/sh\nexit 97\n");
+          assert.equal(yield* fs.readFileString(`${upstream}/.install-complete`), retainedVersion);
+        }
       } else {
         assert.isTrue(Result.isFailure(result));
         if (Result.isFailure(result)) {
```

Parent proof: retain the named SSH focused suites and typecheck below; observe ready → reuse and missing → clear error at launch/MCP entry points, no acquisition/cache reads in either retained branch, and preserved runner bytes. Retain `runtimeArchiveGh.test.ts`'s spaced `ghCommand` override case (asset names derive from `cliArchiveFileName`, so no literal filename hunk is needed). Frozen oracle changes only executable/archive/runtime/home bytes; no new marker or pairing gate is inserted. All execution verifiers remain **NOT RUN by this leaf**.

## D7-A (mandatory in wp4): remote ~/.goat

**MANDATORY; D7 decided by user 2026-10-11 (`~/.goat`).** Apply inside wp4 after core + A11 and preserve the wp2/wp3/wp6 union, to both server and desktop consumers via the shared tunnel service. Remote runtime becomes `~/.goat/runtime/goat/versions/<version>`, state becomes `~/.goat/ssh-launch/<stateKey>`, and default server/pairing/MCP-session home becomes `~/.goat`. The redundant runtime/goat suffix is deliberate: GOAT service install/pinnedRuntime and install scripts use the same home-relative layout, regardless of local/remote home. Do not make remote runner use runtime/versions while the service launcher expects runtime/goat/versions.

No automatic import of `.t3` pid/port/managed/runner/database files. Existing upstream managed/default servers therefore remain outside GOAT discovery/stop/restart scope. keepExistingRunner follows wp2 retained-runner semantics within the GOAT namespace (A11): a ready older/unmarked runner is reused; a missing selected GOAT runtime fails before acquisition. leaveRemoteServerRunning protects the remote server when the local forward ends. The runner filename stays run-t3.sh within the new directory. Local archiveDirectory stays `<local config.baseDir>/runtime/archives`: it is not a remote path and must not be rewritten to `$HOME/.goat` in SshRemoteDispatch.

| Exact absolute path                                                                                                            | Action                    | Purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts`                            | MODIFY (mandatory in wp4) | Every remote runner/runtime lock/staging/probe/upload plus launch/pairing/MCP-session/stop/log state and default server home switches together.                                                                                                                         |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/sshRemote/SshRemoteDispatch.ts`        | MODIFY (mandatory in wp4) | There is no remote-home option in RemoteT3RunnerOptions: tunnel.ts owns the namespace. Keep archiveDirectory LOCAL and keepExistingRunner/leaveRemoteServerRunning true; explain that service boundary here instead of adding handler IO or a disconnected config flag. |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.test.ts`                       | MODIFY (mandatory in wp4) | Remote GOAT fixtures move; the added upstream-collision fixture deliberately stays .t3/runtime/versions so preservation still measures the other product.                                                                                                               |
| `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/fixtures/remote-runner-baseline.json` | MODIFY (mandatory in wp4) | Freeze changed runner/launch/pairing default-home bytes for archive, mirror and node override variants.                                                                                                                                                                 |

### D7-A MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.ts`

Every remote runner/runtime lock/staging/probe/upload plus launch/pairing/MCP-session/stop/log state and default server home switches together.

```diff
--- a/packages/ssh/src/tunnel.ts
+++ b/packages/ssh/src/tunnel.ts
@@ -513,16 +513,16 @@
 # Self-contained release archive: no Node, npm, or compiler on the remote.
 # Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
 T3_RELEASE_BASE_URL=@@T3_RELEASE_BASE_URL@@
-T3_RUNTIME_DIR="$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION"
+T3_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION"
 t3_runtime_ready() {
   [ -x "$T3_RUNTIME_DIR/goat" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]
 }
 if ! t3_runtime_ready; then
-  mkdir -p "$HOME/.t3/runtime/goat/versions"
+  mkdir -p "$HOME/.goat/runtime/goat/versions"
   # Concurrent launches (two clients, a retry racing a slow first run) must
   # not both install: mkdir is the atomic lock and the ready check repeats
   # under it.
-  T3_LOCK="$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"
+  T3_LOCK="$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"
   # mkdir is the only portable atomic exclusive create (mv would silently
   # nest a candidate inside an existing lock). The owner publishes its pid
   # right after, so a lock with a live owner is never reclaimed however
@@ -569,7 +569,7 @@
     *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
   esac
   T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"
-  T3_STAGING="$(mktemp -d "$HOME/.t3/runtime/goat/versions/.staging-XXXXXX")"
+  T3_STAGING="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.staging-XXXXXX")"
   trap 'rm -rf "$T3_STAGING" "$T3_LOCK"' EXIT
   t3_fetch() {
     if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
@@ -609,8 +609,8 @@
 const REMOTE_LAUNCH_SCRIPT = `set -eu
 @@T3_NODE_ENV_SCRIPT@@
 STATE_KEY="$1"
-STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"
-DEFAULT_SERVER_HOME="$HOME/.t3"
+STATE_DIR="$HOME/.goat/ssh-launch/$STATE_KEY"
+DEFAULT_SERVER_HOME="$HOME/.goat"
 DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
 PORT_FILE="$STATE_DIR/port"
 PID_FILE="$STATE_DIR/pid"
@@ -785,8 +785,8 @@
 `;

 const REMOTE_PAIRING_SCRIPT = `set -eu
-STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
-DEFAULT_SERVER_HOME="$HOME/.t3"
+STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
+DEFAULT_SERVER_HOME="$HOME/.goat"
 RUNNER_FILE="$STATE_DIR/run-t3.sh"
 mkdir -p "$STATE_DIR"
 cat >"$RUNNER_FILE" <<'SH'
@@ -837,8 +837,8 @@
 // admits from outside a thread. `--runtime-mode-ceiling` is newer than some
 // remotes, so an older CLI is retried without it and reports the default.
 const REMOTE_MCP_SESSION_SCRIPT = `set -eu
-STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
-DEFAULT_SERVER_HOME="$HOME/.t3"
+STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
+DEFAULT_SERVER_HOME="$HOME/.goat"
 RUNNER_FILE="$STATE_DIR/run-t3.sh"
 mkdir -p "$STATE_DIR"
 if [ "@@T3_KEEP_EXISTING_RUNNER@@" != "1" ] || [ ! -f "$RUNNER_FILE" ]; then
@@ -858,7 +858,7 @@
 `;

 const REMOTE_STOP_SCRIPT = `set -eu
-STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
+STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
 PID_FILE="$STATE_DIR/pid"
 PORT_FILE="$STATE_DIR/port"
 MANAGED_FILE="$STATE_DIR/managed"
@@ -881,7 +881,7 @@
 `;

 const REMOTE_LOG_TAIL_SCRIPT = `set -eu
-STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
+STATE_DIR="$HOME/.goat/ssh-launch/@@T3_STATE_KEY@@"
 LOG_FILE="$STATE_DIR/server.log"
 if [ -f "$LOG_FILE" ]; then
   tail -n 80 "$LOG_FILE" 2>/dev/null || true
@@ -1046,8 +1046,8 @@
   const installer = buildRemoteT3UploadInstallerScript(input, sha256);
   return `set -eu
 umask 077
-mkdir -p "$HOME/.t3/runtime/goat/versions"
-upload_dir="$(mktemp -d "$HOME/.t3/runtime/goat/versions/.upload-XXXXXX")"
+mkdir -p "$HOME/.goat/runtime/goat/versions"
+upload_dir="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.upload-XXXXXX")"
 trap 'rm -rf "$upload_dir"' EXIT
 trap 'exit 1' HUP INT TERM
 cat > "$upload_dir/archive.tar.gz"
@@ -1095,7 +1095,7 @@
   x86_64|amd64) arch=x64 ;;
   *) printf 'Unsupported SSH runtime architecture.\\n' >&2; exit 1 ;;
 esac
-runtime="$HOME/.t3/runtime/goat/versions/$V"
+runtime="$HOME/.goat/runtime/goat/versions/$V"
 ready=false
 if [ -x "$runtime/goat" ] && [ "$(cat "$runtime/.install-complete" 2>/dev/null)" = "$V" ]; then
   ready=true
```

### D7-A MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/apps/server/src/sshRemote/SshRemoteDispatch.ts`

There is no remote-home option in RemoteT3RunnerOptions: tunnel.ts owns the namespace. Keep archiveDirectory LOCAL and keepExistingRunner/leaveRemoteServerRunning true; explain that service boundary here instead of adding handler IO or a disconnected config flag.

```diff
--- a/apps/server/src/sshRemote/SshRemoteDispatch.ts
+++ b/apps/server/src/sshRemote/SshRemoteDispatch.ts
@@ -624,10 +624,10 @@
     const config = yield* ServerConfig.ServerConfig;
     const runner = yield* resolveSshCliRunner(config.baseDir);
     return SshTunnel.SshEnvironmentManager.layer({
-      // Reuse whatever runner a desktop already left for the host, so this
-      // never restarts a remote server another client is using. A host with
-      // none gets this server's own release, uploaded from a local archive
-      // when the build is unpublished, as the desktop does.
+      // Share only the GOAT runner under the tunnel's ~/.goat/ssh-launch.
+      // Keep run-t3.sh there so a second GOAT client cannot restart a managed
+      // server. Do not import/reuse an upstream ~/.t3 runner or server home.
+      // Local archiveDirectory still belongs to this local config.baseDir.
       resolveCliRunner: Effect.succeed(runner),
       leaveRemoteServerRunning: true,
     });
```

### D7-A MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/tunnel.test.ts`

Remote GOAT fixtures move; the added upstream-collision fixture deliberately stays .t3/runtime/versions so preservation still measures the other product.

```diff
--- a/packages/ssh/src/tunnel.test.ts
+++ b/packages/ssh/src/tunnel.test.ts
@@ -230,7 +230,7 @@
       script,
       "T3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'",
     );
-    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION"');
+    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION"');
     assert.include(script, 'T3_ARCHIVE="goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
     assert.include(script, "SHA256SUMS");
     assert.include(script, 'exec "$T3_RUNTIME_DIR/goat" "$@"');
@@ -242,7 +242,7 @@
     // the completion marker after acquiring it.
     assert.include(
       script,
-      'T3_LOCK="$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"',
+      'T3_LOCK="$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock"',
     );
     // mkdir is the exclusive create; the pid follows atomically. A dead owner
     // is reclaimed at once, a never-published owner after a short grace.
@@ -845,7 +845,7 @@
       const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-retained-preparation-" });
       const stateKey = yield* remoteStateKey(uploadTarget);
-      const state = `${root}/.t3/ssh-launch/${stateKey}`;
+      const state = `${root}/.goat/ssh-launch/${stateKey}`;
       const retainedVersion = mode === "invalid" ? "01.2.3" : "1.2.2-preview.20260910.1";
       const retainedScript =
         mode === "dev"
@@ -1035,8 +1035,8 @@
       const fs = yield* FileSystem.FileSystem;
       const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
       const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-preparation-" });
-      const runtime = `${root}/.t3/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
-      const state = `${root}/.t3/ssh-launch/711bc738002d72fd`;
+      const runtime = `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
+      const state = `${root}/.goat/ssh-launch/711bc738002d72fd`;
       yield* fs.makeDirectory(runtime, { recursive: true });
       yield* fs.makeDirectory(state, { recursive: true });
       const cli = `${runtime}/goat`;
@@ -1120,7 +1120,7 @@
       assert.equal((yield* fs.readFileString(`${state}/port`)).trim(), String(started.port));
       assert.equal(yield* fs.readFileString(`${root}/starts`), "start\n");
       assert.isFalse(yield* fs.exists(`${root}/stops`));
-      assert.isFalse(yield* fs.exists(`${root}/.t3/userdata/server-runtime.json`));
+      assert.isFalse(yield* fs.exists(`${root}/.goat/userdata/server-runtime.json`));
       assert.isTrue(yield* child.isRunning);
       yield* child.kill({ killSignal: "SIGTERM" });
       assert.equal(yield* child.exitCode, 0);
@@ -1240,7 +1240,7 @@
       if (!ready)
         assert.equal(
           (yield* fs.readFileString(
-            `${root}/.t3/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-complete`,
+            `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}/.install-complete`,
           )).trim(),
           ARCHIVE.archiveVersion,
         );
@@ -1454,7 +1454,7 @@
         yield* fs.makeDirectory(upstream, { recursive: true });
         yield* fs.writeFileString(`${upstream}/t3`, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
         yield* fs.writeFileString(`${upstream}/.install-complete`, archiveVersion);
-        const runtime = `${root}/.t3/runtime/goat/versions/${archiveVersion}`;
+        const runtime = `${root}/.goat/runtime/goat/versions/${archiveVersion}`;
         if (markerOnly) {
           yield* fs.makeDirectory(runtime, { recursive: true });
           yield* fs.writeFileString(`${runtime}/.install-complete`, archiveVersion);
@@ -1496,9 +1496,9 @@
       assert.equal(result.exitCode, 1);
       assert.include(result.stderr, "Checksum mismatch");
       assert.isFalse(
-        yield* fs.exists(`${root}/.t3/runtime/goat/versions/${archiveVersion}/.install-complete`),
-      );
-      assert.deepEqual(yield* fs.readDirectory(`${root}/.t3/runtime/goat/versions`), []);
+        yield* fs.exists(`${root}/.goat/runtime/goat/versions/${archiveVersion}/.install-complete`),
+      );
+      assert.deepEqual(yield* fs.readDirectory(`${root}/.goat/runtime/goat/versions`), []);
       assert.notInclude(result.stderr, "curl");
     }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
   );
@@ -1525,7 +1525,7 @@
         assert.equal(result.exitCode, 0, result.stderr);
         assert.include(result.stdout, `t3 v${archiveVersion}`);
       }
-      const versions = `${root}/.t3/runtime/goat/versions`;
+      const versions = `${root}/.goat/runtime/goat/versions`;
       assert.deepEqual(yield* fs.readDirectory(versions), [archiveVersion]);
       assert.equal(
         (yield* fs.readFileString(`${versions}/${archiveVersion}/.install-complete`)).trim(),
@@ -1557,7 +1557,7 @@
           assert.equal(result.exitCode, 0, result.stderr);
           assert.include(result.stdout, `t3 v${archiveVersion}`);
         }
-        const versionsDir = `${home}/.t3/runtime/goat/versions`;
+        const versionsDir = `${home}/.goat/runtime/goat/versions`;
         assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
         assert.equal(
           (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
```

### D7-A MODIFY `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename/packages/ssh/src/fixtures/remote-runner-baseline.json`

Freeze changed runner/launch/pairing default-home bytes for archive, mirror and node override variants.

```diff
--- a/packages/ssh/src/fixtures/remote-runner-baseline.json
+++ b/packages/ssh/src/fixtures/remote-runner-baseline.json
@@ -1,17 +1,17 @@
 {
   "archive": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.goat/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.goat/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   },
   "mirror": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.goat/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=1\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.goat/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE=''\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH=''\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://example.invalid/mirror'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   },
   "node": {
-    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
-    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.t3/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=0\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
-    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.t3/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.t3\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.t3/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.t3/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.t3/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.t3/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
+    "runner": "#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"",
+    "launch": "set -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nSTATE_KEY=\"$1\"\nSTATE_DIR=\"$HOME/.goat/ssh-launch/$STATE_KEY\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nDEFAULT_RUNTIME_FILE=\"$DEFAULT_SERVER_HOME/userdata/server-runtime.json\"\nPORT_FILE=\"$STATE_DIR/port\"\nPID_FILE=\"$STATE_DIR/pid\"\nMANAGED_FILE=\"$STATE_DIR/managed\"\nLOG_FILE=\"$STATE_DIR/server.log\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nRUNNER_NEXT=\"$STATE_DIR/run-t3.next.$$\"\nmkdir -p \"$STATE_DIR\"\ncleanup_runner_next() {\n  rm -f \"$RUNNER_NEXT\"\n}\ntrap cleanup_runner_next EXIT\ncat >\"$RUNNER_NEXT\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nRUNNER_CHANGED=0\nif [ ! -f \"$RUNNER_FILE\" ] || ! cmp -s \"$RUNNER_NEXT\" \"$RUNNER_FILE\"; then\n  RUNNER_CHANGED=1\nfi\nmv \"$RUNNER_NEXT\" \"$RUNNER_FILE\"\nchmod 700 \"$RUNNER_FILE\"\nT3_ARCHIVE_MODE=0\nif [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n  # The archive ships the helpers below inside the executable; the remote\n  # needs no Node at all. Resolving the runner once here also downloads the\n  # archive before the port and readiness probes rely on it.\n  \"$RUNNER_FILE\" --version >/dev/null\nelif ! ensure_remote_node_path; then\n  printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n  exit 1\nfi\npick_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper pick-port \"$PORT_FILE\" \"3773\" \"200\"\n    return\n  fi\n  node - \"$PORT_FILE\" \"3773\" \"200\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst net = require(\"node:net\");\nconst filePath = process.argv[2] ?? \"\";\nconst defaultPort = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst scanWindow = Number.parseInt(process.argv[4] ?? \"\", 10);\nconst raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, \"utf8\").trim() : \"\";\nconst preferred = Number.parseInt(raw, 10);\nconst start = Number.isInteger(preferred) ? preferred : defaultPort;\nconst end = start + scanWindow;\n\nfunction tryPort(port) {\n  return new Promise((resolve) => {\n    const server = net.createServer();\n    server.unref();\n    server.once(\"error\", () => resolve(false));\n    server.listen(port, \"127.0.0.1\", () => {\n      server.close((error) => resolve(error ? false : port));\n    });\n  });\n}\n\n(async () => {\n  for (let port = start; port < end; port += 1) {\n    const available = await tryPort(port);\n    if (available) {\n      process.stdout.write(String(port));\n      return;\n    }\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_ready() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper wait-ready \"$REMOTE_PORT\" \"$1\" \"1000\"\n    return\n  fi\n  node - \"$REMOTE_PORT\" \"$1\" \"1000\" <<'NODE'\nconst http = require(\"node:http\");\nconst port = Number.parseInt(process.argv[2] ?? \"\", 10);\nconst timeoutMs = Number.parseInt(process.argv[3] ?? \"\", 10);\nconst probeTimeoutMs = Number.parseInt(process.argv[4] ?? \"\", 10);\nif (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {\n  process.exit(1);\n}\nconst deadline = Date.now() + timeoutMs;\n\nfunction sleep(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\nfunction probe() {\n  return new Promise((resolve) => {\n    const request = http.get(\n      {\n        hostname: \"127.0.0.1\",\n        port,\n        path: \"/\",\n        timeout: probeTimeoutMs,\n      },\n      (response) => {\n        response.resume();\n        response.once(\"end\", () => {\n          resolve(response.statusCode >= 200 && response.statusCode < 300);\n        });\n      },\n    );\n    request.once(\"timeout\", () => {\n      request.destroy();\n      resolve(false);\n    });\n    request.once(\"error\", () => resolve(false));\n  });\n}\n\n(async () => {\n  while (Date.now() < deadline) {\n    if (await probe()) {\n      process.exit(0);\n    }\n    await sleep(100);\n  }\n  process.exit(1);\n})().catch(() => process.exit(1));\nNODE\n}\nwait_for_pid_exit() {\n  PID_TO_WAIT=\"$1\"\n  WAIT_COUNT=0\n  while kill -0 \"$PID_TO_WAIT\" 2>/dev/null && [ \"$WAIT_COUNT\" -lt 20 ]; do\n    WAIT_COUNT=$((WAIT_COUNT + 1))\n    sleep 0.1\n  done\n}\nresolve_default_runtime_port() {\n  if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n    \"$RUNNER_FILE\" __ssh-helper runtime-port \"$DEFAULT_RUNTIME_FILE\"\n    return\n  fi\n  node - \"$DEFAULT_RUNTIME_FILE\" <<'NODE'\nconst fs = require(\"node:fs\");\nconst runtimePath = process.argv[2] ?? \"\";\ntry {\n\t  const runtime = JSON.parse(fs.readFileSync(runtimePath, \"utf8\"));\n\t  const pid = Number(runtime.pid);\n\t  const port = Number(runtime.port);\n\t  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {\n\t    process.exit(1);\n\t  }\n  const origin = new URL(String(runtime.origin ?? \"\"));\n  if (origin.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\"].includes(origin.hostname)) {\n    process.exit(1);\n  }\n  process.kill(pid, 0);\n  process.stdout.write(`${pid} ${port}`);\n} catch {\n  process.exit(1);\n}\nNODE\n}\nREMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\nREMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\nREMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\nDEFAULT_RUNTIME_INFO=\"$(resolve_default_runtime_port 2>/dev/null || true)\"\nDEFAULT_RUNTIME_PID=\"\"\nDEFAULT_REMOTE_PORT=\"\"\nif [ -n \"$DEFAULT_RUNTIME_INFO\" ]; then\n  DEFAULT_RUNTIME_PID=\"${DEFAULT_RUNTIME_INFO%% *}\"\n  DEFAULT_REMOTE_PORT=\"${DEFAULT_RUNTIME_INFO#* }\"\nfi\nif [ -n \"$DEFAULT_REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n  if wait_ready \"2000\"; then\n    if [ \"$REMOTE_MANAGED\" = \"managed\" ]; then\n      PID_TO_STOP=\"${REMOTE_PID:-$DEFAULT_RUNTIME_PID}\"\n      if [ -n \"$PID_TO_STOP\" ] && kill -0 \"$PID_TO_STOP\" 2>/dev/null; then\n        kill \"$PID_TO_STOP\" 2>/dev/null || true\n        wait_for_pid_exit \"$PID_TO_STOP\"\n      fi\n      REMOTE_PID=\"\"\n      REMOTE_PORT=\"$DEFAULT_REMOTE_PORT\"\n      REMOTE_MANAGED=\"external\"\n      rm -f \"$PID_FILE\"\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n    else\n      printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n      printf 'external\\n' >\"$MANAGED_FILE\"\n      REMOTE_PID=\"\"\n      REMOTE_MANAGED=\"external\"\n    fi\n  else\n    REMOTE_PID=\"$(cat \"$PID_FILE\" 2>/dev/null || true)\"\n    REMOTE_PORT=\"$(cat \"$PORT_FILE\" 2>/dev/null || true)\"\n    REMOTE_MANAGED=\"$(cat \"$MANAGED_FILE\" 2>/dev/null || true)\"\n  fi\nfi\nif [ \"$REMOTE_MANAGED\" = \"external\" ]; then\n  if [ -z \"$REMOTE_PORT\" ] || ! wait_ready \"2000\"; then\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelif [ -n \"$REMOTE_PID\" ] && [ -n \"$REMOTE_PORT\" ] && kill -0 \"$REMOTE_PID\" 2>/dev/null; then\n  if [ \"$RUNNER_CHANGED\" -eq 1 ]; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  elif ! wait_ready \"2000\"; then\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    REMOTE_PID=\"\"\n    REMOTE_PORT=\"\"\n    REMOTE_MANAGED=\"\"\n  fi\nelse\n  REMOTE_PID=\"\"\n  REMOTE_PORT=\"\"\n  REMOTE_MANAGED=\"\"\nfi\nif [ -z \"$REMOTE_PORT\" ]; then\n  REMOTE_PORT=\"$(pick_port)\" || true\n  if [ -z \"$REMOTE_PORT\" ]; then\n    if [ \"$T3_ARCHIVE_MODE\" = \"1\" ]; then\n      printf 'Failed to find an available port on the remote host.\\n' >&2\n    else\n      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2\n    fi\n    exit 1\n  fi\n  nohup env T3CODE_NO_BROWSER=1 \"$RUNNER_FILE\" serve --host 127.0.0.1 --port \"$REMOTE_PORT\" --base-dir \"$DEFAULT_SERVER_HOME\" >>\"$LOG_FILE\" 2>&1 < /dev/null &\n  REMOTE_PID=\"$!\"\n  printf '%s\\n' \"$REMOTE_PID\" >\"$PID_FILE\"\n  printf '%s\\n' \"$REMOTE_PORT\" >\"$PORT_FILE\"\n  printf 'managed\\n' >\"$MANAGED_FILE\"\n  if ! wait_ready \"60000\"; then\n    printf 'Remote T3 server did not become ready on 127.0.0.1:%s.\\n' \"$REMOTE_PORT\" >&2\n    if [ -s \"$LOG_FILE\" ]; then\n      tail -n 80 \"$LOG_FILE\" >&2 2>/dev/null || true\n    else\n      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' \"$LOG_FILE\" >&2\n    fi\n    kill \"$REMOTE_PID\" 2>/dev/null || true\n    wait_for_pid_exit \"$REMOTE_PID\"\n    rm -f \"$PID_FILE\" \"$PORT_FILE\" \"$MANAGED_FILE\"\n    exit 1\n  fi\nfi\nprintf '{\"remotePort\":%s,\"serverKind\":\"%s\"}\\n' \"$REMOTE_PORT\" \"${REMOTE_MANAGED:-managed}\"\n",
+    "pairing": "set -eu\nSTATE_DIR=\"$HOME/.goat/ssh-launch/711bc738002d72fd\"\nDEFAULT_SERVER_HOME=\"$HOME/.goat\"\nRUNNER_FILE=\"$STATE_DIR/run-t3.sh\"\nmkdir -p \"$STATE_DIR\"\ncat >\"$RUNNER_FILE\" <<'SH'\n#!/bin/sh\nset -eu\nprepend_path_if_dir() {\n  if [ -d \"$1\" ]; then\n    case \":$PATH:\" in\n      *\":$1:\"*) ;;\n      *) PATH=\"$1:$PATH\" ;;\n    esac\n  fi\n}\n\nremote_node_satisfies_engine() {\n  T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'\n  if [ -z \"$T3_NODE_ENGINE_RANGE\" ]; then\n    return 0\n  fi\n  node - \"$T3_NODE_ENGINE_RANGE\" <<'NODE'\nfunction satisfiesSemverRange(rawVersion, range) {\n    const normalizedVersion = String(rawVersion).trim().replace(/^v/, \"\");\n    const versionMatch = normalizedVersion.match(\n      /^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-[0-9A-Za-z.-]+)?$/,\n    );\n    if (!versionMatch) {\n      return false;\n    }\n\n    const version = {\n      major: Number(versionMatch[1]),\n      minor: Number(versionMatch[2] || 0),\n      patch: Number(versionMatch[3] || 0),\n    };\n\n    return range.split(\"||\").some((group) => {\n      const comparators = group.trim().split(/\\s+/).filter(Boolean);\n      if (comparators.length === 0) {\n        return false;\n      }\n      return comparators.every((comparator) => {\n        const match = comparator.trim().match(/^(\\^|>=|>|<=|<|=)?\\s*v?(\\d+(?:\\.\\d+){0,2})$/);\n        if (!match) {\n          return false;\n        }\n        const targetVersion = match[2];\n        if (targetVersion === undefined) {\n          return false;\n        }\n        const targetMatch = targetVersion.match(/^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?$/);\n        if (!targetMatch) {\n          return false;\n        }\n        const target = {\n          major: Number(targetMatch[1]),\n          minor: Number(targetMatch[2] || 0),\n          patch: Number(targetMatch[3] || 0),\n        };\n        const compared =\n          version.major !== target.major\n            ? version.major > target.major\n              ? 1\n              : -1\n            : version.minor !== target.minor\n              ? version.minor > target.minor\n                ? 1\n                : -1\n              : version.patch !== target.patch\n                ? version.patch > target.patch\n                  ? 1\n                  : -1\n                : 0;\n        const operator = match[1] || \"=\";\n        switch (operator) {\n          case \"^\":\n            if (compared < 0) {\n              return false;\n            }\n            if (target.major > 0) {\n              return version.major === target.major;\n            }\n            if (target.minor > 0) {\n              return version.major === 0 && version.minor === target.minor;\n            }\n            return version.major === 0 && version.minor === 0 && version.patch === target.patch;\n          case \">=\":\n            return compared >= 0;\n          case \">\":\n            return compared > 0;\n          case \"<=\":\n            return compared <= 0;\n          case \"<\":\n            return compared < 0;\n          case \"=\":\n            return compared === 0;\n          default:\n            return false;\n        }\n      });\n    });\n  }\n(function remoteNodeEngineCheckMain() {\n  const range = process.argv[2] || \"\";\n  const rawVersion =\n    process.versions && process.versions.node ? process.versions.node : process.version;\n\n  if (!satisfiesSemverRange(rawVersion, range)) {\n    process.stderr.write(\n      \"Remote node \" + rawVersion + \" does not satisfy required range \" + range + \".\\n\",\n    );\n    process.exit(1);\n  }\n})();\nNODE\n}\n\nensure_remote_node_path() {\n  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then\n    return 0\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/bin\"\n  prepend_path_if_dir \"$HOME/bin\"\n  prepend_path_if_dir \"/opt/homebrew/bin\"\n  prepend_path_if_dir \"/home/linuxbrew/.linuxbrew/bin\"\n  prepend_path_if_dir \"/usr/local/bin\"\n  prepend_path_if_dir \"/usr/bin\"\n  prepend_path_if_dir \"/bin\"\n\n  if [ -z \"${VOLTA_HOME:-}\" ]; then\n    VOLTA_HOME=\"$HOME/.volta\"\n  fi\n  export VOLTA_HOME\n  prepend_path_if_dir \"$VOLTA_HOME/bin\"\n\n  prepend_path_if_dir \"$HOME/.asdf/shims\"\n  prepend_path_if_dir \"$HOME/.asdf/bin\"\n  if [ ! -x \"$HOME/.asdf/shims/node\" ] && [ -s \"$HOME/.asdf/asdf.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$HOME/.asdf/asdf.sh\"\n  fi\n\n  prepend_path_if_dir \"$HOME/.local/share/mise/shims\"\n  prepend_path_if_dir \"$HOME/.mise/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then\n    eval \"$(mise activate sh)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${FNM_DIR:-}\" ]; then\n    FNM_DIR=\"$HOME/.local/share/fnm\"\n  fi\n  export FNM_DIR\n  prepend_path_if_dir \"$FNM_DIR\"\n  prepend_path_if_dir \"$HOME/.fnm\"\n  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then\n    eval \"$(fnm env --shell bash)\" >/dev/null 2>&1 || true\n    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true\n  fi\n\n  prepend_path_if_dir \"$HOME/.nodenv/bin\"\n  prepend_path_if_dir \"$HOME/.nodenv/shims\"\n  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then\n    eval \"$(nodenv init -)\" >/dev/null 2>&1 || true\n  fi\n\n  if [ -z \"${NVM_DIR:-}\" ]; then\n    NVM_DIR=\"$HOME/.nvm\"\n  fi\n  export NVM_DIR\n\n  if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    # shellcheck disable=SC1090\n    . \"$NVM_DIR/nvm.sh\"\n    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then\n      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true\n    fi\n  fi\n\n  if ! command -v node >/dev/null 2>&1 && [ -d \"$NVM_DIR/versions/node\" ]; then\n    for T3_NODE_BIN in \"$NVM_DIR\"/versions/node/*/bin; do\n      if [ -x \"$T3_NODE_BIN/node\" ]; then\n        PATH=\"$T3_NODE_BIN:$PATH\"\n        export PATH\n      fi\n    done\n  fi\n\n  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine\n}\nT3_NODE_SCRIPT_PATH='/fixture/cli entry.mjs'\nif [ -n \"$T3_NODE_SCRIPT_PATH\" ]; then\n  # Dev mode: a source checkout on the remote. This is the only path that\n  # needs Node, so Node discovery runs here and nowhere else.\n  ensure_remote_node_path || true\n  if ! command -v node >/dev/null 2>&1; then\n    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2\n    exit 1\n  fi\n  exec node \"$T3_NODE_SCRIPT_PATH\" \"$@\"\nfi\nT3_ARCHIVE_VERSION=''\nif [ -z \"$T3_ARCHIVE_VERSION\" ]; then\n  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2\n  exit 1\nfi\n# Self-contained release archive: no Node, npm, or compiler on the remote.\n# Unpacked into the pinned-runtime layout so `goat service install` reuses it.\nT3_RELEASE_BASE_URL='https://github.com/goat-si/goat/releases/download'\nT3_RUNTIME_DIR=\"$HOME/.goat/runtime/goat/versions/$T3_ARCHIVE_VERSION\"\nt3_runtime_ready() {\n  [ -x \"$T3_RUNTIME_DIR/goat\" ] && [ \"$(cat \"$T3_RUNTIME_DIR/.install-complete\" 2>/dev/null)\" = \"$T3_ARCHIVE_VERSION\" ]\n}\nif ! t3_runtime_ready; then\n  mkdir -p \"$HOME/.goat/runtime/goat/versions\"\n  # Concurrent launches (two clients, a retry racing a slow first run) must\n  # not both install: mkdir is the atomic lock and the ready check repeats\n  # under it.\n  T3_LOCK=\"$HOME/.goat/runtime/goat/versions/.$T3_ARCHIVE_VERSION.install.lock\"\n  # mkdir is the only portable atomic exclusive create (mv would silently\n  # nest a candidate inside an existing lock). The owner publishes its pid\n  # right after, so a lock with a live owner is never reclaimed however\n  # slow its download is, and a lock whose owner is dead is reclaimed at\n  # once. A lock with no pid at all is a crash between mkdir and the pid\n  # write; it is reclaimed after a short grace so a live owner has time to\n  # publish.\n  T3_LOCK_WAITED=0\n  T3_LOCK_UNOWNED=0\n  while ! mkdir \"$T3_LOCK\" 2>/dev/null; do\n    T3_LOCK_OWNER=\"$(cat \"$T3_LOCK/pid\" 2>/dev/null || true)\"\n    if [ -n \"$T3_LOCK_OWNER\" ]; then\n      T3_LOCK_UNOWNED=0\n      if ! kill -0 \"$T3_LOCK_OWNER\" 2>/dev/null; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    else\n      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))\n      if [ \"$T3_LOCK_UNOWNED\" -ge 5 ]; then\n        rm -rf \"$T3_LOCK\"\n        continue\n      fi\n    fi\n    if [ \"$T3_LOCK_WAITED\" -ge 360 ]; then\n      printf 'Another GOAT %s installation has held %s for too long.\\n' \"$T3_ARCHIVE_VERSION\" \"$T3_LOCK\" >&2\n      exit 1\n    fi\n    sleep 1\n    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))\n  done\n  printf '%s\\n' \"$\" > \"$T3_LOCK/pid.tmp\" && mv \"$T3_LOCK/pid.tmp\" \"$T3_LOCK/pid\"\n  trap 'rm -rf \"$T3_LOCK\"' EXIT\nfi\nif ! t3_runtime_ready; then\n  case \"$(uname -s)\" in\n    Darwin) T3_PLATFORM=\"darwin\" ;;\n    Linux) T3_PLATFORM=\"linux\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -s)\" >&2; exit 1 ;;\n  esac\n  case \"$(uname -m)\" in\n    arm64 | aarch64) T3_ARCH=\"arm64\" ;;\n    x86_64 | amd64) T3_ARCH=\"x64\" ;;\n    *) printf 'Remote host %s has no GOAT release archive.\\n' \"$(uname -m)\" >&2; exit 1 ;;\n  esac\n  T3_ARCHIVE=\"goat-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz\"\n  T3_STAGING=\"$(mktemp -d \"$HOME/.goat/runtime/goat/versions/.staging-XXXXXX\")\"\n  trap 'rm -rf \"$T3_STAGING\" \"$T3_LOCK\"' EXIT\n  t3_fetch() {\n    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time \"$3\" \"$1\" -o \"$2\"\n    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 \"$1\" -O \"$2\"\n    else printf 'Remote host needs curl or wget to download %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n    fi\n  }\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS\" \"$T3_STAGING/SHA256SUMS\" 30\n  t3_fetch \"$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE\" \"$T3_STAGING/$T3_ARCHIVE\" 240\n  T3_EXPECTED=\"$(grep \" \\*\\{0,1\\}$T3_ARCHIVE$\" \"$T3_STAGING/SHA256SUMS\" | cut -d' ' -f1)\"\n  if command -v sha256sum >/dev/null 2>&1; then\n    T3_ACTUAL=\"$(sha256sum \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  else\n    T3_ACTUAL=\"$(shasum -a 256 \"$T3_STAGING/$T3_ARCHIVE\" | cut -d' ' -f1)\"\n  fi\n  if [ -z \"$T3_EXPECTED\" ] || [ \"$T3_ACTUAL\" != \"$T3_EXPECTED\" ]; then\n    printf 'Checksum mismatch for %s.\\n' \"$T3_ARCHIVE\" >&2; exit 1\n  fi\n  tar -xzf \"$T3_STAGING/$T3_ARCHIVE\" -C \"$T3_STAGING\" --strip-components=1\n  rm -f \"$T3_STAGING/$T3_ARCHIVE\" \"$T3_STAGING/SHA256SUMS\"\n  # Prove the binary runs here (libc, arch) before marking it ready, or every\n  # later launch would exec a broken install instead of retrying.\n  if ! \"$T3_STAGING/goat\" --version >/dev/null 2>&1; then\n    printf 'The goat %s executable does not run on this host.\\n' \"$T3_ARCHIVE_VERSION\" >&2; exit 1\n  fi\n  printf '%s\\n' \"$T3_ARCHIVE_VERSION\" > \"$T3_STAGING/.install-complete\"\n  rm -rf \"$T3_RUNTIME_DIR\"\n  mv \"$T3_STAGING\" \"$T3_RUNTIME_DIR\"\nfi\nif [ -n \"${T3_LOCK:-}\" ]; then\n  rm -rf \"$T3_LOCK\"\n  trap - EXIT\nfi\nexec \"$T3_RUNTIME_DIR/goat\" \"$@\"\nSH\nchmod 700 \"$RUNNER_FILE\"\nPAIRING_BASE_DIR=\"$DEFAULT_SERVER_HOME\"\n\"$RUNNER_FILE\" auth pairing create --base-dir \"$PAIRING_BASE_DIR\" --json\n"
   }
 }
```

## D7-B: discarded / not executable

The user chose D7-A (`~/.goat`) on 2026-10-11. Keeping remote state or server home under `~/.t3` is discarded; do not apply it, run its former verification gates, or use core-only remote `.t3` after-images as the final implementation. Upstream `~/.t3/userdata`, its runner and ownership files remain untouched. Any GOAT `.t3` paths in core/projected hunks are intermediate before-images for D7-A; explicit upstream-preservation fixtures retain `.t3`; local default-home/service-id limitations remain separately recorded.

## Conditional activation and meaningful proof

| Behavior / scenario                       | Activation                                                                                                                   | Observable pass evidence                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| archive/executable names agree            | shared archive name cases for POSIX and Windows; existing real fake-archive npm packaging; WSL archive structural preflight  | goat archive names, tar root/goat present, platform-package executable bit and actual npm launcher stdout/exit-code passthrough; native helper names unchanged                                                          |
| legacy npm bin compatibility              | existing t3-only manifest/global-bin/native fixtures                                                                         | still classify valid installation; npx/pnpm/bunx t3 channel suggestions unchanged                                                                                                                                       |
| new npm goat ownership                    | added dual-bin native fixture with unrelated global t3 and missing/matching goat                                             | unknown until goat bin proves package ownership; matching version recognized; mismatching platform manifest remains unknown; foreign t3 bytes survive                                                                   |
| same exact version upstream cache         | pinnedRuntime's real filesystem test + SSH runShell/upload + installer HTTP test seed runtime/versions/version/t3 and marker | GOAT installs into runtime/goat/versions and upstream executable+marker bytes survive unchanged                                                                                                                         |
| marker-only stale GOAT cache              | SSH test and successful installer fixture seed matching marker without goat                                                  | probe ready=false, install downloads/uploads rather than claiming cached; working goat/marker published; subsequent probe true                                                                                          |
| checksum failure / concurrent preparation | retained SSH checksum-mismatch/racing-upload/launch cases and pinnedRuntime progress/concurrency cases                       | nonzero/no completed runtime on mismatch; one complete namespace after concurrent upload; no auth/remote download fallback introduced                                                                                   |
| desktop foreign shim                      | create goat symlink to upstream T3 marker + upstream t3 entry                                                                | state unowned; install refuses; remove does not delete foreign link; after fixture removes the conflict, GOAT install/remove leaves t3 unchanged                                                                        |
| prior GOAT shim refresh                   | existing previous-home and large-binary link tests with goat paths/new marker                                                | recognizes only GOAT marker; refresh/removal uses GOAT links; large binaries/foreign links never claimed                                                                                                                |
| second client / runner ownership          | existing compatible managed-server test + A11 retained-readiness cases + frozen script oracle                                | ready retained GOAT runtime reuses even for older/unmarked runner; missing selected runtime errors before acquisition; persisted runner/pid/port/managed bytes and old runtime survive; captured server remains running |
| D7-A isolation (mandatory)                | all shell fixtures use .goat except upstream-collision fixture                                                               | runtime/state/default server home point to .goat; .t3 upstream bytes untouched; no import of old runner/pid/DB; wp5 must inspect selected base-dir and host process evidence                                            |
| ghCommand override retained from wp2      | `runtimeArchiveGh.test.ts`: spaced executable path supplied through runner.ghCommand after core + A11 + D7-A composition     | configured executable receives gh acquisition; verified cache bytes upload; no accidental PATH-default substitution                                                                                                     |
| help/string surfaces                      | retained CLI parser help/error tests and standalone command formatter, web update command-output tests                       | commandPath/root/help goat; npx t3 remains executable package hint; web/desktop install/remove label and mobile pairing hint readable by source inspection (no static-markup tests)                                     |

PowerShell has an exact NEW test hunk in `scripts/install-windows.test.ts`: real install.ps1 through a local HTTP/ZIP fixture using a copied native Node executable as the --version stand-in. It checks marker-only/broken entries force download, runnable cache avoids archive download, goat.cmd runs, and upstream runtime/t3.cmd survives. This proves installer behavior, not GOAT SEA output; hosted artifact smoke owns that proof. It skips non-Windows; a macOS skip is not Windows evidence. The 120-second harness timeout bounds native compression/extraction; it never sleeps or polls for orchestration completion.

## Verification recipes (parent only; NOT RUN by leaf)

The single **Verification bundle** at the end selects the same 28 focused test files (27 existing, one planned NEW Windows suite) after integrating core + A11 + mandatory D7-A. Every test invocation runs from its owning package directory with package-relative paths. Shared/ssh/scripts use the explicit root config and `--dir .`, matching their package.json recipes; server/desktop/client-runtime use their own configs; web uses its package recipe's `--project unit`. Deliberately omit `--passWithNoTests`: each named file must be discovered. Record each exit; no-tests-found is a failure. wp2's `runtimeArchiveGh.test.ts` spaced `ghCommand` override remains mandatory.

The eight named typecheck configs exist: scripts includes `**/*.ts`; shared/ssh/client-runtime include `src`; server and desktop include `src` plus their config/script inputs; web includes `src` plus config/vite/script inputs; mobile inherits Expo's default includes. These commands observe code and test targets, not this prose plan; human review verifies plan completeness.

Expected exit 0 for tests/typechecks; Linux/Windows installer tests **SKIP on macOS** is not installer proof. From the source `scripts` package directory, run `vp test run --config ../vite.config.ts --dir . install.test.ts` on existing Linux CI and `vp test run --config ../vite.config.ts --dir . install-windows.test.ts` on existing Windows CI or authorized test hosts. Do not install a new runner/package or substitute a broad suite. Record baseline failures separately; missing dependencies/config/tool are BLOCKED. No repo-wide vp check or recursive test/typecheck. SEA/signing/archive output needs wp5's authorized local build plus hosted target-specific Windows/Linux builds; tests do not prove cross-platform binaries exist.

### Stale-name gates

Run these gates from `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename` (reset cwd after the package test blocks).

`rg` empty means exit **1**, not exit 0. Errors (exit 2) fail the gate. Each expected-empty command scopes out intentional npm identities, native helpers, historical ids and frozen templates except where stated.

```sh
# Expected empty (exit 1): production executable selection and direct archive consumers.
rg -n 'fileName: "t3"|"t3\.exe" : "t3"|executableName === "t3"|/t3"|/t3`|\$\{stem\}/t3|archives=\(t3-|wsl-runtime/t3-\*' apps/server/vite.config.ts scripts/build-cli-archive.ts scripts/build-npm-platform-packages.ts scripts/build-desktop-artifact.ts scripts/smoke-cli-archive.ts packages/shared/src/legacyCliLauncher.ts apps/server/src/cloud/pinnedRuntime.ts apps/server/src/serviceLauncher.ts packages/ssh/src/tunnel.ts apps/desktop/src/wsl/DesktopWslEnvironment.ts apps/desktop/src/backend/DesktopBackendConfiguration.ts .github/workflows/release.yml .github/workflows/release-desktop.yml
# Expected empty (exit 1): installer/archive outputs and old unnamespaced runtime writes.
rg -n 'stem="t3-|\$stem = "t3-|target_dir\}/t3|bin_dir\}/t3|targetDir .t3\.exe.|binDir "t3\.cmd"|runtime/versions|runtime\\versions' scripts/install.sh scripts/install.ps1 packages/ssh/src/tunnel.ts apps/server/src/serviceLauncher.ts apps/server/src/cloud/pinnedRuntime.ts
# Expected empty (exit 1): root parser and CLI-help commandPath.
rg -n 'Command\.make\("t3"|commandPath: \["t3"' apps/server/src/binCli.ts
# Expected empty (exit 1): plain runtime help command strings; npm package runners are an allowed output filtered in next gate.
rg -n 't3 (service|connect|pair|browser|update|serve|uninstall|app|triage|trace|help)' apps/server/src/cli apps/server/src/cloud apps/server/src/preview/PreviewBrowserHost.ts apps/web/src/components/settings/CliCommandSettingsRow.tsx apps/web/src/components/cloud/ConnectCliAuthSurface.tsx apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx --glob '!*.test.*' --glob '!**/invocation.ts' | rg -v '(npx|bunx|pnpm dlx) t3'
# Allowed output: package identities/launcher paths only; inspect that these did not become goat npm packages.
rg -n '"name": "t3"|NPM_LAUNCHER_PACKAGE_NAME|NPM_PLATFORM_PACKAGE_SCOPE|bin: \{|bin/t3\.js|@t3code/t3-|npx t3|npm (install|i|uninstall).* t3' apps/server/package.json scripts/build-npm-platform-packages.ts packages/shared/src/legacyCliLauncher.ts apps/server/src/cli/invocation.ts scripts/install.sh scripts/install.ps1
# Allowed output: GOAT-owned goat links and unique GOAT marker; legacy marker only in preservation tests.
rg -n 'Written by (GOAT|T3 Code)|goat-cli-command-path-entry|goat\.cmd|"goat"|"t3"' apps/desktop/src/app/DesktopCliShim.ts apps/desktop/src/app/DesktopCliCommand.ts
# Allowed output: persisted coordination names still run-t3.sh/run-t3.next, including doc comment; no run-goat names.
rg -n 'run-t3|run-goat' packages/ssh/src/tunnel.ts
```

Mandatory D7-A gates:

```sh
# Expected empty (exit 1): every production remote script now uses .goat.
rg -n '\$HOME/\.t3' packages/ssh/src/tunnel.ts
# Expected matching output: runner, upload and probe runtime roots; all launch/pairing/session/stop/log states; default home.
rg -n '\$HOME/\.goat|DEFAULT_SERVER_HOME|STATE_DIR|runtime=' packages/ssh/src/tunnel.ts
```

For the pipeline help gate, inspect each stage exit: first rg may return 1 (no input), second rg should return 1 (all retained matches are allowed npm runner invocations). Shell pipeline success/failure alone is not sufficient if the first stage errors. Gates are early warnings (human executing rg/source review, known bypass: other unlisted files/new spellings; residual risk: missed consumers; final layer none). Behavior/targeted CI and archive inspection are the deciding evidence.

## Risks, rollback and amendment requests

- **Recorded D8 amendment:** apply `runtime/goat/versions` namespace for local+remote archives and independent Windows desktop PATH ownership receipt. Mandatory D7-A also isolates remote home/state. Core-only remote `.t3` paths are intermediate hunks, not the final wp4 implementation.
- **D7 decided:** mandatory remote runtime is `~/.goat/runtime/goat/versions/<v>`, not a home-relative layout inconsistent with pinnedRuntime/serviceLauncher. D7-A is an isolated new home; no migration of user data or persisted ownership is proposed.
- **D4 limitation remains:** private repo + unauthenticated install/update consumers can still fail; rename/auth code does not publish releases or npm packages. Public install URLs t3.codes still represent upstream infrastructure, and public npm t3 may serve upstream. Parent must preserve this distinction in wp5 evidence and final reporting.
- **Existing service ids/local home remain shared:** no service install/update/uninstall/restart is authorized against a live upstream installation. Namespaced runtime does not isolate service plans/receipts. A later default-home/service-id policy would require explicit scope/decision amendment.
- **Baseline bytes cause lifecycle change:** ordinary launch mode legitimately flags changed managed runner; keepExistingRunner must remain true for second-client paths. run-t3.sh retention does not transform an old runner into GOAT. A11 extends wp2's single retained probe: ready older/unmarked GOAT runners reuse their selected runtime; missing selected runtimes fail before download/upload, leaving the runner unchanged. Mandatory D7-A avoids importing upstream coordination; D7-B is discarded and not executable.
- **Windows fixture scope:** the new installer harness tests a path with spaces and actual goat.cmd execution. Desktop shim suites retain existing Unicode/codepage tests. Standalone install/update cmd shim Unicode/codepage behavior predates this rename and is not changed here; if it fails on a particular Windows host, record that baseline and amend a separate quoting/encoding fix rather than treating an ASCII-host run as general Unicode proof.
- **Cache checks:** matching version marker alone was accepted by installers; POSIX adds -x + runnable --version; Windows adds leaf executable + runnable --version. Namespace provides product ownership, not output branding. SSH probe still uses executable+marker presence (existing readiness contract), upload runner validates before publishing. Do not add unrelated checksum revalidation of all warm caches in wp4.
- **Rollback before deployment:** restore the edited source hunks as one parent-controlled unit, then rerun focused tests. Never apply name rollback to only producer or only consumers; archive/executable names must stay matched. No branch-level git action by this leaf.
- **Rollback after a future authorized run:** disconnect local tunnel without stopping remote (`leaveRemoteServerRunning`); keep both old/new runtime trees and run-t3.sh state for inspection. Parent chooses any service handoff with explicit live-service authorization. Do not delete `.goat`, `.t3`, archives, pid/port files, or user DB as automatic rollback. Newly added desktop goat links may be removed only through GOAT-owned link checks; upstream t3 remains untouched. Publishing/release rollback is out of scope.

## Leaf proof boundary

This stale-check leaf read the delegation owner, current plan/ordering and source bytes at cd1dfd752, then compared every core + A11 + D7-A before-image against source or the literal preceding-stage projection in memory. All 385 hunks match, including exact context and old/new line counts; the NEW Windows test has an absent source before-image. All recorded source hashes match. Selective Codex/Aside/kim_wiki memory lookup found no relevant overriding rename decision. Only this document is written. No source edit, build, test, install, server, SSH connection, git mutation, FSM/goal call, child spawn or browser/computer-use occurred. Static plan/source comparisons do not establish implementation, test pass, READY or release status. Parent owns execution and independent review of the landed wp2/wp3/wp6 union plus wp4.

## Verification bundle

Parent only; **NOT RUN** by this leaf. All test recipes run from their owning package directories; the final eight typechecks run from the source root. Run installer suites on their named target hosts for non-skip evidence.

```sh
set -eu
GOAT_RENAME_SOURCE=/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename

cd "$GOAT_RENAME_SOURCE/packages/shared"
vp test run --config ../../vite.config.ts --dir . src/cliRelease.test.ts

cd "$GOAT_RENAME_SOURCE/packages/ssh"
vp test run --config ../../vite.config.ts --dir . src/tunnel.test.ts src/runtimeArchive.test.ts src/runtimeArchiveGh.test.ts

cd "$GOAT_RENAME_SOURCE/apps/server"
vp test run src/cloud/pinnedRuntime.test.ts src/cloud/bootService.test.ts src/cloud/selfUpdate.test.ts src/cloud/relayResponse.test.ts src/serviceLauncher.test.ts
vp test run src/cli/invocation.test.ts src/cli/update.test.ts src/cli/uninstall.test.ts src/cli/app.test.ts src/cli/pair.test.ts src/cli/service.test.ts src/cli/triagePrompt.test.ts src/preview/PreviewBrowserHost.test.ts

cd "$GOAT_RENAME_SOURCE/apps/desktop"
vp test run src/app/DesktopCliShim.test.ts src/app/DesktopCliCommand.test.ts src/wsl/DesktopWslEnvironment.test.ts src/backend/DesktopBackendConfiguration.test.ts

cd "$GOAT_RENAME_SOURCE/apps/web"
vp test run --project unit src/components/ServerUpdateAction.test.tsx src/components/settings/settingsSearch.test.ts

cd "$GOAT_RENAME_SOURCE/packages/client-runtime"
vp test run src/preview/serverBrowserStream.test.ts

cd "$GOAT_RENAME_SOURCE/scripts"
vp test run --config ../vite.config.ts --dir . build-npm-platform-packages.test.ts build-desktop-artifact.test.ts
vp test run --config ../vite.config.ts --dir . install.test.ts install-windows.test.ts

cd "$GOAT_RENAME_SOURCE"
vp exec tsc -p packages/shared/tsconfig.json --noEmit
vp exec tsc -p packages/ssh/tsconfig.json --noEmit
vp exec tsc -p packages/client-runtime/tsconfig.json --noEmit
vp exec tsc -p apps/server/tsconfig.json --noEmit
vp exec tsc -p apps/desktop/tsconfig.json --noEmit
vp exec tsc -p apps/web/tsconfig.json --noEmit
vp exec tsc -p apps/mobile/tsconfig.json --noEmit
vp exec tsc -p scripts/tsconfig.json --noEmit
```

## Audit fold (cycle 4)

1. Blocker: packages/shared/src/legacyCliLauncher.test.ts fixture executable renamed from `…/t3` to `…/goat` (matching the launcher hunk at line ~400); add `src/legacyCliLauncher.test.ts` to the shared command in the Verification bundle.
2. Fix: do NOT introduce new hosting domains. Every hunk that writes `goat.codes`, `app.goat.codes` or similar new URLs keeps the established URL (`t3.codes`, `app.t3.codes`, existing install URLs) while still renaming the command/executable to `goat` where the command itself is described. GOAT hosting is out of scope (no deploy authority).
