# 000 — GOAT release source and goat naming (roadmap)

GOAT installs its runtime on SSH hosts by downloading `t3-<version>-<platform>` from the upstream `pingdotgg/t3code` releases. GOAT versions are never published there, so dispatching to a host such as `juns-macbook-pro` fails with `curl: (56) ... 404`. This unit makes GOAT resolve releases from its own private repository `goat-si/goat` through the locally authenticated `gh` CLI and renames the agent-facing MCP tools and the CLI executable to `goat`. Agents see `goat_*` tools; operators get a `goat` command; SSH hosts receive GOAT archives uploaded from the local machine.

Source worktree: `/Users/jun/Developer/new/700_projects/t3code-lanes/goat-release-rename` (branch `codex/goat-release-rename`, base `dfd768cb5` = goat/ssh-remote-dispatch).
Research: `001_inventory.md` (three gpt-6.1-sol read-only inventories, summarized).

## Loop spec

- Archetype: satisfy-spec, multi-cycle (wp1 docs-only roadmap, then one PABCD per work-phase).
- Trigger: user report "자꾸 t3 릴리즈를 찾고 있어" while probing juns-macbook-pro; request to look up releases with gh against goat-si/goat and name the tool goat (MCP + CLI executable, user answer 2026-10-11).
- Goal: SSH runtime preparation never touches pingdotgg; MCP tools are `goat_*` on a server named GOAT; CLI executable and archives are `goat`.
- Non-goals: publishing a GitHub release, pushing, PRs, merging, restarting the user's running dev app (pid 89653 in t3code-lanes/ssh-dispatch-goat), renaming `T3CODE_*` env vars, npm package name `t3`, mobile store ids, upstream T3 Connect relay, converting every unauthenticated release consumer to authenticated access (recorded as limitation).
- Verifier: per build cycle `vp test run <touched test files>` + targeted typecheck (`vp exec tsc -p <pkg> --noEmit` style per package) + rg stale-name gates listed in each decade doc + independent gpt-6.1-sol review PASS. wp5: real SSH run against juns-macbook-pro with captured output.
- Stop condition: all five goalplan criteria met with fresh evidence, or a blocking condition (gh/SSH unavailable, a needed user decision).
- Memory artifact: this unit (`devlog/_fin/261011_goat-release-rename/`), goalplan `.codexclaw/goalplans/goat-release-source-goat-naming-hotl-cxc-loop-re/`, evidence under `evidence/`.
- Terminal outcomes: DONE (criteria met), NEEDS_HUMAN (release publish/push/state-dir decision), BLOCKED (gh or SSH missing), BUDGET none stated; host limits apply.
- Escalation: remote state-dir collision decision (D7), any need to publish a release, any change touching the user's live `~/.t3/userdata` on either machine.
- Resources: tools = local shell, gh (account lidge-jun, keyring), ssh to juns-macbook-pro (key/agent), gpt-6.1-sol subagents unlimited (user grant). Write scope = source worktree + this devlog unit + goalplan state; remote write scope (wp5 only) = GOAT runtime/state dir on juns-macbook-pro decided by D7.

## Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                      | Reason                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `packages/shared/src/cliRelease.ts` exports `CLI_RELEASE_REPOSITORY = "goat-si/goat"`; independent copies (scripts/install.sh, scripts/install.ps1, packaging/aur/scripts/release.sh, apps/marketing/src/lib/releases.ts, scripts/build-npm-platform-packages.ts links) follow.                                                                               | One source of truth; every resolver now points at GOAT.                                                                                                          |
| D2  | SSH acquisition order in `prepareRemoteRuntime`: remote ready → cached local archive in archiveDirectory → when no explicit releaseBaseUrl, local `gh release download v<ver> --repo goat-si/goat --pattern <asset> --pattern SHA256SUMS --dir <scoped tmp>`, verify sha256 against SHA256SUMS, move into archiveDirectory, upload through the existing path. | Private repo: only an authenticated local client can read it; the remote never needs credentials.                                                                |
| D3  | gh failures (not installed, unauthenticated, release or asset missing, checksum mismatch) raise `SshLaunchError` naming repo, tag, asset and the local archive directory; no silent fallback to anonymous remote download. An explicit `T3CODE_RELEASE_BASE_URL` mirror keeps the remote download path unchanged.                                             | A clear local error replaces an opaque remote curl 404.                                                                                                          |
| D4  | Other anonymous consumers (`t3 update` index, cloud pinnedRuntime/selfUpdate/bootService, install scripts, mobile environment-maintenance) are only retargeted by D1. Converting them to authenticated access is a follow-up.                                                                                                                                 | Keeps scope to the reported failure; documented as a limitation.                                                                                                 |
| D5  | MCP: the 42 `t3_*` tools become `goat_*`; `McpServer.layerHttp` name `"T3 Code"` → `"GOAT"`; shared presentation keeps `t3_*` read-side aliases so persisted history still renders.                                                                                                                                                                           | User choice; history compatibility without DB rewrite.                                                                                                           |
| D6  | Provider registration key `t3-code` (qualified ids `mcp__t3-code__*`) → `goat` as its own work-phase wp6, executed after wp3 and before wp4 (A12) so wp5 probes final names.                                                                                                                                                                                  | 36 extra files with parser/allowlist logic (ACP regexes, Pi exposure, OpenCode isolation); isolating it keeps wp3 reviewable.                                    |
| D7  | **Decided by user 2026-10-11: SSH hosts use `~/.goat`** for runtime (`~/.goat/runtime/goat/versions/<v>`), ssh-launch state (`~/.goat/ssh-launch`) and server home (`--base-dir ~/.goat`). 030 §D7-A is the implemented variant; §D7-B is discarded. No migration of upstream `~/.t3`.                                                                        | juns-macbook-pro runs upstream T3 Nightly on `~/.t3/userdata`; sharing it with a GOAT server risks the user's live data; same-version runtime dirs also collide. |
| D8  | CLI: SEA executable `goat`, archives `goat-<version>-<platformKey>`, npm package stays `t3` with bins `goat` and `t3`, desktop CLI shim installs `goat`, help/user strings say `goat`; `npx t3`/`npm i -g t3` strings that name the npm package stay.                                                                                                         | User choice; npm identity unchanged avoids workspace/filter churn.                                                                                               |
| D9  | wp5 builds a local darwin-arm64 archive (`scripts/build-cli-archive.ts`) into the archive directory and prepares juns-macbook-pro through the upload path, then runs a read-only probe thread with claude-opus-5-5. No release is published.                                                                                                                  | goat-si/goat has zero releases; publishing is unauthorized.                                                                                                      |

## Work-phase map (dependency order)

| WP  | Doc                        | Scope                 | Depends |
| --- | -------------------------- | --------------------- | ------- |
| wp1 | this + 001                 | docs-only roadmap     | —       |
| wp2 | 010_release_source_gh.md   | D1–D4                 | wp1     |
| wp3 | 020_mcp_goat_tools.md      | D5                    | wp2     |
| wp6 | 050_provider_key_goat.md   | D6 (A12)              | wp3     |
| wp4 | 030_cli_goat_executable.md | D8 + D7-A (mandatory) | wp6     |
| wp5 | 040_e2e_macbook_probe.md   | D9                    | wp4     |

## Architect consultation

Recorded in `002_architect.md` (proposal handle, decision dispositions, reflection verdict).

## Finding F1 (2026-10-11, live evidence)

`juns-macbook-pro` is this Mac (same hostname juns-MacBook-Pro, SSH loops back). Its `~/.t3/ssh-launch/0d73bce7088860f3/run-t3.sh` (written 05:47 KST) was left by an upstream T3 Code Nightly desktop: `T3_ARCHIVE_VERSION='0.0.45-nightly.20261010.7'`, `T3_RELEASE_BASE_URL='https://github.com/pingdotgg/t3code/releases/download'`; only `0.0.45-nightly.20261010.6` is installed under `~/.t3/runtime/versions`. The server dispatch runs with `keepExistingRunner: true`, so it reuses this upstream runner, which downloads a nightly that has no CLI archive → `curl: (56) 404`. Retargeting releases alone cannot fix this while GOAT shares `~/.t3/ssh-launch` with upstream clients. This strengthens D7 = separate remote root (`~/.goat`). Evidence: `evidence/f1-remote-runner.txt`.

Execution order (A12): wp2 → wp3 → wp6 → wp4 → wp5.

## Amendments from decade writers (2026-10-11)

- D1+: include desktop release-note links and AUR PKGBUILD/release.sh URLs (010).
- D2/D3+: MCP session issuance on a cold host also runs preparation; a missing cache directory is created, unsupported platforms are rejected before gh, never anonymous fallback (010).
- D5+: aliases cover presentation and identity recovery only; `resolveT3McpToolId` keeps original names; provider namespace stays `t3-code` until wp6; fresh provider sessions required after cutover (020).
- D6+: fresh-session cutover, single Pi registration, legacy OpenCode deny rules kept, Claude allowlists combine D5+D6 names; real file count 83 (050).
- D8+: GOAT runtime directory is `<root>/runtime/goat/versions/<v>` everywhere (local pinned runtime, service launcher, installers, SSH), so it never collides with upstream `runtime/versions/<v>`; Windows PATH ownership marker separate from upstream's (030).
- D7-A (mandatory, user decision): root = `~/.goat` on SSH hosts → runtime `~/.goat/runtime/goat/versions/<v>`, state `~/.goat/ssh-launch`, server home `~/.goat` (030 §D7-A).

## Deviation V1 (2026-10-11)

cxc SOURCE-DELTA-01 refuses B→C when the bound source worktree is unchanged, and the roadmap lives in the native cwd, so a docs-only cycle cannot close through the FSM. The full roadmap (000–050) was written, reflected (architect ALIGNED after folds) and independently audited (003: FAIL → NEAR-PASS, no blockers, all 010/020/050 hunks matched HEAD dfd768cb5) before any code. wp1 is therefore marked done at that audit, and the same FSM cycle's B implements wp2 from 010 without re-planning. Later cycles keep one work-phase per PABCD.

## Deviation V2 (2026-10-11): FSM cycle ↔ goalplan phase mapping

Because of V1, the goalplan's active phase lags one behind the content: FSM cycle 2 closes goalplan wp2 while implementing 020 (wp3 content); cycle 3 closes wp3 while implementing 050 (wp6); cycle 4 closes wp6 while implementing 030 (wp4); cycle 5 closes wp4 while running 040 (wp5) plus any fixes it finds; cycle 6 closes wp5 with the final user-doc/cleanup delta. Each record (060+) names both the closed goalplan phase and the implemented decade doc. State files are not hand-edited.

V2 update (after cycle 3): the goalplan advanced its active phase to wp4 at cycle 3's close, so cycle 4 closes wp4 while implementing 030 (aligned again). wp6's tasks were completed in cycle 3 (062 record).
