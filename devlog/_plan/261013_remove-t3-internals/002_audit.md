# 002 — Audit record (wp1 roadmap)

## Audit 1 — gpt-6.1-sol (task t2-audit-1) — VERDICT: FAIL

Nine blockers, all folded into `000_plan.md`:

| #   | Finding                                                                                                         | Fold                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Legacy module in shared would create a contracts→shared cycle; shell installers cannot import TS.               | D3: `packages/contracts/src/legacyT3Names.ts` (dependency-free) + `goat-rename: legacy` line/region markers.                                      |
| 2   | Replay order lacked the tool bootstrap; sync recipe ran a GOAT-only script inside a raw upstream checkout.      | D2 three-layer layout; `--root`; sync recipe rewritten.                                                                                           |
| 3   | Entry-point adoption misses `loadRepoEnv`, desktop shell hydration, Vite/Metro/Expo configs, installers, shims. | D5 applies `withLegacyEnvAliases` to every env source.                                                                                            |
| 4   | Older children (retained service versions, ACP bridge, SSH server) read only legacy names.                      | D6 dual emission for all child-process handoffs.                                                                                                  |
| 5   | Home fallback checked only `userdata`, missing `dev` state.                                                     | D8 uses the effective mode's state directory.                                                                                                     |
| 6   | New wire spellings break older peers (CORS allowlist, link parsers).                                            | D17 two-phase rollout: dual readers now, legacy writers kept.                                                                                     |
| 7   | `RUNNER_CHANGED` is never consumed; older clients discover only `run-t3.sh`.                                    | D17 keeps runner bytes, filename and assignments; only TS identifiers renamed.                                                                    |
| 8   | Installed service identity had no phase.                                                                        | D16 defers it explicitly; new units set both env names.                                                                                           |
| 9   | Missed V2 checkpoint namespace and unassigned persisted readers.                                                | D17 lists both checkpoint generations and `refs/t3code/pre-refresh`; D11 covers themes, temp branches, managed worktrees; MCP-app queries in D17. |

Non-blocking folds: lockfile regenerated again after wp8 (D4); D9 precedence spelled out; D10 acceptance cases (DPoP CryptoKeys, WAL, interrupted copy); D7 narrowed to exact relay keys; `.goat` in `.gitignore` (D8); public-URL check before image deletion (D14).

Full reviewer output:

VERDICT: FAIL

Static audit of D1–D15. The rename is feasible, but the plan leaves several data-preservation and version-skew gaps.

**BLOCKERS**

1. **D1/D3: the single excluded module crosses dependency and runtime boundaries.** `shared` depends on `contracts` ([packages/shared/package.json:502](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/shared/package.json:502)); legacy wire constants also belong to contracts, which currently depends only on Effect. Importing shared there creates a dependency cycle. Standalone installers cannot import TypeScript constants either ([scripts/install.sh:22](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/scripts/install.sh:22)). **Fix:** use a dependency-free compatibility manifest, generate standalone aliases, and exempt generated compatibility regions and the rename rules’ match operands. Idempotence must preserve legacy spellings, not merely produce an unchanged second run.

2. **D2: the replay procedure lacks its bootstrap.** wp2 creates the rename script in a hand-written commit, while D2 replays hand commits after running it; the future-sync recipe checks out a raw upstream tag and immediately invokes that GOAT-only script ([000_plan.md:42](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/devlog/_plan/261013_remove-t3-internals/000_plan.md:42), [000_plan.md:54](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/devlog/_plan/261013_remove-t3-internals/000_plan.md:54)). **Fix:** retain or replay a separate tooling bootstrap first, then mechanical commits, then compatibility patches. Document how the tool runs against an upstream checkout.

3. **D5: entry-point adoption does not cover later or separate environment sources.** Expo reads the returned `repoEnv` object directly ([apps/mobile/app.config.ts:14](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/mobile/app.config.ts:14)); `loadRepoEnv` merges files separately ([scripts/lib/public-config.ts:33](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/scripts/lib/public-config.ts:33)). Desktop later hydrates the telemetry opt-out from login shells ([DesktopShellEnvironment.ts:453](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/desktop/src/shell/DesktopShellEnvironment.ts:453)). **Fix:** normalize each configuration source and returned map, adopt after shell hydration, and provide alias-aware Effect configuration for supplied providers. Explicitly cover independently loaded Vite/Metro/Expo configs, installers, shims, and ACP fast-path dispatch.

4. **D5: inbound adoption cannot make older subprocesses understand new exports.** The service launcher starts arbitrary retained versions with one context variable ([serviceLauncher.ts:430](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/serviceLauncher.ts:430)); older children read only that legacy variable ([serviceLauncherClient.ts:119](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/cloud/serviceLauncherClient.ts:119)). ACP credentials similarly cross a subprocess boundary ([adapter.ts:702](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/provider-acp/src/server/adapter.ts:702)). **Fix:** add dual emission or version-aware emission for launcher context/home, desktop-server handoffs, generated shims, SSH server startup, and ACP bridge environments. Test upgrade and rollback directions.

5. **D7: checking only `userdata` misses existing development state.** Implicit web development uses `<home>/dev` ([apps/server/src/config.ts:140](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/config.ts:140)); desktop development likewise defaults to `~/.t3/dev` ([DesktopStatePaths.ts:19](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/desktop/src/app/DesktopStatePaths.ts:19)). A machine with legacy `dev` but no legacy `userdata` fails D7’s fallback condition. **Fix:** select the legacy root using the effective mode’s state location, consistently across CLI, desktop development, and dev-runner, while preserving explicit overrides and worktree isolation.

6. **D10: accepting old input does not preserve compatibility with old readers.** New browser requests containing `x-goat-orchestration-protocol` fail older servers’ CORS allowlist ([httpCors.ts:4](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/httpCors.ts:4)); endpoint fallback alone cannot fix that. Older clients also recognize only `t3-thread` links ([threadLinks.ts:19](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/shared/src/threadLinks.ts:19)). **Fix:** negotiate header/output vocabulary, or retain legacy wire emission during the compatibility window. Cover new web/mobile clients against old servers and old clients against new servers, including links, citations, clipboard payloads, and MCP-app outputs.

7. **D11: the asserted restart mechanism does not exist.** `RUNNER_CHANGED` is initialized and assigned but never consumed ([tunnel.ts:1039](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/ssh/src/tunnel.ts:1039), [tunnel.ts:1477](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/ssh/src/tunnel.ts:1477)). Restart is controlled by `NEEDS_OWNED_UPGRADE`; compatible servers are reused ([tunnel.ts:1374](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/ssh/src/tunnel.ts:1374)). Older clients discover only `run-t3.sh` and legacy assignments ([tunnel.ts:1830](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/packages/ssh/src/tunnel.ts:1830)). **Fix:** define whether a spelling-only replacement needs any restart. Preserve old-client discovery with a compatible runner alias, shared locks, retained-byte verification, and existing ownership/idle safeguards.

8. **Installed service identity migration has no work phase.** Service names and launchd labels are durable identifiers ([bootService.ts:34](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/cloud/bootService.ts:34)); status and restart inspect only the selected unit path ([bootService.ts:954](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/cloud/bootService.ts:954)). Environment adoption does not discover renamed units. **Fix:** add legacy-name discovery, dual home-key parsing, coordinated replacement/removal, and rollback—or explicitly defer these identity renames. Compatibility must accompany their mechanical rename.

9. **D10/inventory miss the active V2 checkpoint namespace.** It is `refs/t3/orchestration-v2/checkpoints`, distinct from the listed `refs/t3/checkpoints` ([CheckpointService.ts:26](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/orchestration-v2/CheckpointService.ts:26)). Other inventoried compatibility requirements lack explicit phase assignments: MCP-app history queries ([ProjectionStore.ts:4758](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/server/src/orchestration-v2/ProjectionStore.ts:4758)), legacy theme aliases, temporary branches, and managed-worktree recognition. **Fix:** enumerate both checkpoint generations and assign every persisted reader/query a dual-read strategy before changing writers.

**NON-BLOCKING findings**

1. **D4 is feasible for current GOAT distribution.** Nightly publishes GitHub release artifacts ([goat-nightly.yml:5](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/.github/workflows/goat-nightly.yml:5)). Keep both CLI bins; regenerate the lockfile again after native module/path changes in wp8.

2. **D8 is sound with precise precedence.** Apply identical selection rules to server loading and client queries ([useT3ProjectFileScripts.ts:36](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/web/src/hooks/useT3ProjectFileScripts.ts:36)). Specify both-files-present behavior and fallback only on absence, not invalid configuration.

3. **D9 is feasible but needs migration acceptance cases.** Preserve structured-cloned DPoP keys ([dpop.ts:24](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/apps/web/src/cloud/dpop.ts:24)), SQLite WAL consistency, interrupted-copy recovery, and existing attachment URIs.

4. **D6/D12/D13 are mostly justified.** Relay code consumes `x-t3-hook-outcome`; preserve it. Keep both desktop schemes and the complete runtime identity. Narrow env exemptions to exact relay/domain keys; local `T3CODE_WEB_SOURCEMAP` is not relay vocabulary. Cursor/OpenCode display labels are not demonstrated immutable contracts.

5. **D14/D15 are reasonable scope boundaries.** Public-image deletion needs URL-use review beyond source references. Add `.goat` to ignore rules while retaining `.t3` ([.gitignore:18](/Users/jun/.goat/worktrees/goat/chore-remove-t3-internals-r2/.gitignore:18)); legacy fallback can still create/use that directory.

## Audit 2 — gpt-6.1-sol (task t2-audit-2) — VERDICT: FAIL → folded, recorded as NEAR-PASS

Round-1 folds: 1, 2, 4–9 RESOLVED; 3 PARTIAL (supplied Effect `ConfigProvider`s). New blockers and folds:

| #           | Finding                                                                                           | Fold                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 3 (partial) | Tests and layers supply their own `ConfigProvider`.                                               | D5: alias-aware `ConfigProvider` wrapper.                                                                                |
| N1          | OAuth bootstrap token-type URN is a cross-version literal.                                        | D17, request schema accepts both.                                                                                        |
| N2          | Desktop bootstrap JSON key `t3Home` and HMAC prefix `t3-desktop-bootstrap:` cross desktop↔server. | D17.                                                                                                                     |
| N3          | Legacy MCP registration names and the OpenCode `t3-code-*` deny rule.                             | D12 keep, read through `legacyT3Names.ts`.                                                                               |
| N4          | Deleting old storage keys breaks rollback.                                                        | D10: never delete in this PR; rollback sees data as of upgrade time. This follows the user's spec "read old, write new". |

Non-blocking folds: contracts subpath export (D3); dev-runner forwards the worktree home explicitly (D8).

Residual (near-pass): no third round. Each fold is a concrete plan line, and each work-phase B is reviewed again against the code before commit.

Full reviewer output:

VERDICT: FAIL

Statuses assess the revised roadmap, not an implemented migration.

1. **RESOLVED** — D3 removes the dependency cycle: shared already depends on contracts (`packages/shared/package.json:502`); shell compatibility regions are explicitly exempted.
2. **RESOLVED** — D2 now bootstraps tooling before mechanical changes; `--root` lets the GOAT checkout operate on raw upstream.
3. **PARTIAL** — D5 covers separately loaded maps and shell hydration, but omits supplied Effect `ConfigProvider`s (`apps/server/src/cli/config.test.ts:191`). Require alias-aware Config lookups/providers, preserving GOAT-first precedence.
4. **RESOLVED** — D6 explicitly covers retained service children, desktop/server, ACP, MCP, SSH and user scripts; this addresses the single-name spawn at `apps/server/src/serviceLauncher.ts:430`.
5. **RESOLVED** — D8 selects by effective state directory, covering implicit `dev` and explicit/worktree `userdata` (`apps/server/src/config.ts:142`; `apps/desktop/src/app/DesktopStatePaths.ts:34`).
6. **RESOLVED** — D17 retains the originally identified endpoint, header, link, clipboard and MCP-output writers. Additional omissions appear below.
7. **RESOLVED** — Keeping runner bytes, filename and assignments avoids the nonexistent restart mechanism and preserves old discovery (`packages/ssh/src/tunnel.ts:1830`).
8. **RESOLVED** — D16 explicitly retains installed identities, avoiding orphaned units (`apps/server/src/cloud/bootService.ts:34`); new units emit both env names.
9. **RESOLVED** — D17 includes V1/V2 checkpoints and pre-refresh refs; D11 assigns theme/worktree/branch readers, and D17 assigns MCP-output queries (`apps/server/src/orchestration-v2/ProjectionStore.ts:4758`).

**NEW BLOCKERS**

1. **D17 omits the bootstrap OAuth token-type URN.** `packages/contracts/src/auth.ts:238` defines `urn:t3:params:oauth:token-type:environment-bootstrap`; line 308 requires that exact literal. Both bearer and DPoP clients emit it (`packages/client-runtime/src/authorization/remote.ts:105`, `:133`). Renaming it breaks pairing against older servers and rejects older clients on newer servers. **Fix:** explicitly add it to D17, retain legacy emission, and accept both values in the request schema.

2. **D17 omits desktop bootstrap wire keys and cryptographic vocabulary.** `packages/contracts/src/desktopBootstrap.ts:12` serializes `t3Home`; desktop supplies it at `apps/desktop/src/backend/DesktopBackendConfiguration.ts:566`, and server consumes it at `apps/server/src/cli/config.ts:325`. Mechanical identifier renaming changes the JSON key, so a mismatched peer can silently select another data root. Separately, `packages/shared/src/desktopBootstrapToken.ts:24` uses `t3-desktop-bootstrap:` as the HMAC input; desktop derives credentials while server validates them (`apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts:99`; `apps/server/src/auth/PairingGrantStore.ts:345`). **Fix:** retain the `t3Home` wire writer with dual decoding and retain the HMAC string during the compatibility window. Rename internal bindings independently.

3. **Historical MCP names and security deny rules lack an explicit preservation assignment.** `packages/shared/src/t3McpToolPresentation.ts:96`, `:474`, and `:488` recognize persisted `t3-code`, `t3_code`, `t3code` and thread-scoped registrations. More critically, `packages/provider-opencode/src/server/v2/adapter.ts:484` denies `t3-code-*` registrations left in reused daemons. Renaming that literal removes isolation for those registrations. **Fix:** add these aliases/patterns to the legacy manifest and keep-list; preserve old presentation parsers and the legacy deny rule alongside GOAT rules.

4. **D10 contradicts the promised rollback preservation.** The plan permits deleting legacy keys after a successful new write and retaining old databases only until copying completes (`000_plan.md:30`). Older builds read only the original names: drafts use `t3code:composer-drafts:v1` (`apps/web/src/composerDraftStore.ts:90`), mobile connections use `t3code.connections` (`apps/mobile/src/persistence/mobile-storage.ts:16`), and DPoP keys use `t3code:cloud-auth` (`apps/web/src/cloud/dpop.ts:24`). Rollback can therefore lose access to existing drafts, connections and keys. Merely retaining an unchanged old copy also misses subsequent writes. **Fix:** keep legacy storage authoritative during the compatibility window, or specify compatible mirrored writes and rollback recovery; defer deletion.

**NON-BLOCKING notes**

- D3 should expose a dedicated contracts subpath for the dependency-free manifest; current exports are explicitly enumerated (`packages/contracts/package.json:9`).
- D8 verification should distinguish implicit development homes from worktree homes forwarded as explicit env values (`scripts/dev-runner.ts:327`), preserving directory selection and isolation.
- D13/D16 deferrals are justified; retaining those identities introduces no migration loss.
- Static, read-only audit only; no files changed or servers started.

## wp5 review — gpt-6.1-sol (task t2-wp5-review-1) — VERDICT: FAIL → folded

| #   | Finding                                                                                                    | Fold                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `bin.ts` normalized before dispatching `__service-launcher`, so retained older versions lost legacy names. | Server and desktop adopt without deleting; the launcher carries both spellings to its children.   |
| 2   | Server/desktop Vite configs and Metro read raw env.                                                        | Vite configs import `@goat/contracts/adoptLegacyEnv` first; Metro adopts its one variable inline. |
| 3   | Operator scripts and replay recorders read raw env.                                                        | Each imports `@goat/contracts/adoptLegacyEnv` first.                                              |
| 4   | No alias-aware `ConfigProvider`.                                                                           | Rebutted: no production code builds a provider from a user env record; D5 text corrected.         |
| 5   | `loadRepoEnv` aliased after merging, breaking source priority.                                             | Each source is aliased before merging.                                                            |
| 6   | Pi and Claude MCP handoffs emitted only new names.                                                         | Both spellings emitted; Pi scrubs inherited credentials under both.                               |
| 7   | WSL backend of an older build lost forwarded settings.                                                     | Forwarded names and `WSLENV` carry both spellings; owned names filtered under both.               |
| 8   | CLI shims emitted only GOAT names; project-script overrides left stale legacy values.                      | Shims export both; legacy names are derived after overrides.                                      |

## wp6 review — gpt-6.1-sol (task t2-wp6-review-1) — VERDICT: FAIL → folded

| #   | Finding                                                                           | Fold                                                                                                     |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | A hand-launched desktop dev build ignored `~/.t3/dev`.                            | `resolveDesktopBaseDir` takes `pathExists`; the desktop environment passes it.                           |
| 2   | `goat pair` resolved one default home for both `userdata` and `dev`.              | Resolves the default per state variant.                                                                  |
| 3   | The temp-branch collision check looked only at the `goat` namespace.              | Checks the requested branch's own namespace.                                                             |
| 4   | Mobile clients would hand `goat/<hex>` temp branches to older servers.            | Writers keep `t3/<hex>`, `goat/` is accepted; moved to D17.                                              |
| 5   | Reconstructed baseline checkpoint refs were read only under the legacy namespace. | `checkpointRefCandidatesForScopeOrdinal`; baseline materialization and diffs take the first that exists. |

Non-blocking: D8's one-time log of the legacy-home fallback is not emitted; left out as noise.

## wp7/wp8a review — gpt-6.1-sol (task t2-wp78-review-1) — VERDICT: FAIL → folded

| #   | Finding                                                                                  | Fold                                                                                                     |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Duplicating large legacy drafts can exhaust localStorage, after which draft writes fail. | Over quota, the adapter drops that key's retained legacy copy and retries once, then surfaces the error. |
| 2   | A pending async adoption could land after a newer write or clear.                        | Async operations are serialized per key.                                                                 |

Non-blocking: WSL marker promotion publishes through a temp file and rename. A negative cache for absent keys was tried and dropped: it outlived what it described, and the reads it saved are startup-only.
