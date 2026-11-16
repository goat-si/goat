# dev merge b53dea9e4b into chase/t3-261114-all (scratch branch chase/t3-261114-all-merge-dev)

Integration merge of origin/dev at b53dea9e4b (#3209 part 3/3: ACP Registry, OpenCode and Pi follow the current PATH and profile; #3389) into chase/t3-261114-all at 74ae8cc7b2, on the scratch branch chase/t3-261114-all-merge-dev. Merge commit d4feb0da89, then L10's pending per-check delta cherry-picked from chase/t3-261114-opencode-retry-2 (4d910e93e2): d504b12b66 (eddd99c3bf) and 7d1a951e5d (844f142d1c).

The rule used for every hunk: #3209's environment plumbing is the frame (a check or a new launch reads the host environment current at that moment; a session keeps the environment it opened with), and L10's behaviour (the closed #3362 body is its record) runs inside it. Nothing of either side was dropped.

## Conflict hunks

All five conflicted files are in packages/provider-opencode/src/server. Line numbers are in the merged file at d4feb0da89.

| file / hunk                               | #3209 (dev) wanted                                                                                               | L10 wanted                                                                                                                                                                          | result                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| driver.ts imports (contracts)             | `MemoryModelSelection` for the memory preflight                                                                  | `type ServerProviderModel` for project models                                                                                                                                       | both; `MemoryModelSelection` moved with the text-generation selector (see Budgets), driver.ts:1-2                                                                                                                                                                                                                  |
| driver.ts imports (snapshotProbe)         | `classifySpawnFailure`, `isCommandMissingCause`, `findSpawnFailure`                                              | `resolveProviderProbeTimeoutMs`                                                                                                                                                     | both; the spawn helpers moved with the selector to runtimeTextGeneration.ts:9-12, :17                                                                                                                                                                                                                              |
| driver.ts `makeOpenCode2ModelLoader` call | list keyed by the captured launch, `captureLaunch`, `sameOpenCodeServerLaunch`                                   | pass the environment for the settle timeout override                                                                                                                                | dev's three arguments plus `currentEnvironment` as a fourth, read per load, driver.ts:489                                                                                                                                                                                                                          |
| driver.ts usage (legacy reader)           | read OpenCode Go usage with `currentEnvironment` per check                                                       | rename to `legacyUsageLimits`, wrapped by the OpenCode 2 usage reader                                                                                                               | L10's name on dev's per-check read, driver.ts:605                                                                                                                                                                                                                                                                  |
| driver.ts usage + `checkProvider`         | `checkProvider` reads one environment and provides `LaunchEnvironment` to the whole check                        | OpenCode 2 usage reader (`withGoatUsageScopes`, unsupported-version cache, 10 s timeout, probeFailed fallback); pass the environment to `checkOpenCodeProviderStatus`               | L10's usage reader, now itself one environment per usage check (it also runs standalone from the managed provider), driver.ts:620; dev's `checkProvider` wrapper passing its per-check `environment` to `checkOpenCodeProviderStatus` (external-server inventory connection and its health timeout), driver.ts:646 |
| driver.ts `snapshotForCwd` (three hunks)  | one `currentEnvironment` read per scan, `LaunchEnvironment` provided to the scan                                 | v2: a third read for project models (`readSettledOpenCode2Catalog`, `workspaceModelsFor`), workspace scan timeout `2 x` the override; v1: `models` from the inventory, same timeout | dev's wrapper around L10's three-part `Effect.all`; the catalog settle and both scan timeouts read the wrapper's `environment`, driver.ts:851, :872, :887, :917                                                                                                                                                    |
| status.ts loader signature                | generic `Identity`, list as a function of the identity, `sameIdentity`                                           | `settleOpenCode2Catalog`, 5 s settle constant, `environment` for the override                                                                                                       | both: L10's helpers at status.ts:399; dev's signature plus `environment?: Effect.Effect<ProcessEnv>`, status.ts:420-426                                                                                                                                                                                            |
| status.ts loader body (suspend vs gen)    | `Effect.gen` with an identity reset of `lastLoaded`                                                              | `Effect.suspend`                                                                                                                                                                    | dev's gen and reset, status.ts:434; the settle timeout resolved from the environment effect at each load, status.ts:439                                                                                                                                                                                            |
| status.ts tracked list                    | read `list(currentIdentity)` with its own repeat-until-settled                                                   | `tracked` list, retry while plugins activate, 2-minute first-read deadline, settle within the override                                                                              | L10's chain built on the identity-selected list, status.ts:445; `lastLoaded` updates only while the identity is unchanged (dev), status.ts:469                                                                                                                                                                     |
| v2/OpenCode2Server.ts `withConnection`    | `captureLaunch`, `runningVersion`, connections by URL, `withConnection(use, launch)`                             | lend `processExit` from the owned server's exit code (recovery, a135972c7e)                                                                                                         | dev's structure lending `{ ...connection, processExit }`, OpenCode2Server.ts:242-249                                                                                                                                                                                                                               |
| v2/adapter.ts reconnect                   | `borrowConnection(server, initial.launch)` (L10's `borrow` was identical to the base, so nothing of L10 is lost) | subscribe to events inside the borrow's scope (recovery, a135972c7e)                                                                                                                | both, adapter.ts:2482-2485                                                                                                                                                                                                                                                                                         |
| versionProbe.ts imports                   | `LaunchEnvironment`                                                                                              | `resolveProviderProbeTimeoutMs`                                                                                                                                                     | both, versionProbe.ts:16-18                                                                                                                                                                                                                                                                                        |

## Construction-time environment reads converted (merged without conflict)

These L10 lines merged cleanly but read `processEnv`, which since #3209 is only the startup copy:

- workspace scan wait in `listOpenCode2Workspace`: `yield* currentEnvironment`, driver.ts:561;
- v1 command inventory timeout in `loadWorkspaceInventory`: reads `currentEnvironment` per call, driver.ts:698;
- the service restart after an update (b68aedfdb7) is a new launch, so `replaceOutdatedService` gets the current environment, driver.ts:775-779;
- OpenCode 2 server readiness timeout (`verifyServer` in `connectTo`) read `input.environment`. `OpenCodeServerOwner.make`'s `verify` now also receives the launch it verifies (OpenCodeServerOwner.ts:64, :165), so an owned server's timeout follows the environment it was launched with (OpenCode2Server.ts:202), a configured server's follows the environment current at connect (:170), and a memory server's follows its isolated environment (:220).

Pi's status.ts and Registry's probe.ts merged cleanly and already read the per-check environment their drivers pass (`checkPiProviderStatus`, `discoverPiCommandsForCwd` through `currentEnvironment`; Registry's `checkAcpRegistryProviderStatus` through `readinessInput(environment)`).

## L10 delta folded in

- d504b12b66 (eddd99c3bf): Antigravity's provider takes `environment` as an effect read at each check. It conflicted only with the coordinator's one-line 554708b1bc (`environment: yield* currentEnvironment`); eddd99c3bf's per-check `environment: currentEnvironment` replaces it, apps/server/src/provider/Drivers/AntigravityDriver.ts:480. #3209 has no Antigravity code, so no better home.
- 7d1a951e5d (844f142d1c): Codex skills scan timeout from the per-scan environment. Applied cleanly.

## Auto-merged files checked by reading

- provider-acp-registry probe.ts: L10's `acp_registry` timeout override reads `input.environment`, which is the per-check probe environment.
- provider-pi status.ts: L10's overrides read the `environment` parameter; dev's driver passes the per-check environment.
- provider-opencode adapter.ts (v1), textGeneration.ts: L10's variants, tool times, resumed child ordinals and steer admission; no environment reads.
- provider-opencode v2/OpenCode2Server.test.ts: both sides' tests kept; passes.
- provider-opencode driver.test.ts: dev's only change removes "refreshes the probe environment after the host PATH changes while preserving instance overrides", now at driver.launchEnvironment.test.ts:231; L10 never edited it. L10's removed update tests live in driver.updates.test.ts:48 and :139, which dev did not touch. No test exists twice.
- `vi.mock` factories in provider-opencode, provider-acp-registry and provider-pi: usage.test.ts spreads the real modules; OpenCode2Service.test.ts mocks `@opencode/client/effect/service`, whose only importer is OpenCode2Service.ts (`Service`). Neither side newly imports a name a factory leaves out.

## Tests changed

- status.openCode2Profile.test.ts:25 (dev's test) advances the clock 2 minutes instead of 5 seconds: with L10's loader a first read may wait out a cold server's plugin activation for up to 2 minutes, and only the settling shares the 5 s budget. The assertion is unchanged (the new profile's never-answering read returns `[]`, not the earlier profile's models). The window this leaves, where after a host environment change the old profile's status and models stay shown for up to 2 minutes while a cold server activates its plugins, is goat#3415. Follow-up 6ed6661718 on chase/t3-261114-opencode-retry-2 ends a lent server's hung model read 20 seconds after the new server is lent (or at a larger GOAT_OPENCODE_PROBE_TIMEOUT_MS read per check; with the server start, never more than about 2 minutes), so this test now advances 20 seconds, and only the plugin-loading 503 keeps the 2-minute retry; the window that remains is in L10-retry.md Known limits.

## Budgets

`selectOpenCodeRuntimeTextGeneration` (dev's memory selector, 145 lines) moved byte-identically to packages/provider-opencode/src/server/runtimeTextGeneration.ts (the merged driver.ts was 1110 lines and has no entry). Lengths read with `node oxlint-plugin-goat/update-code-budgets.ts`, rewrite discarded; no entry changed.

| file                                                            | dev entry         | branch entry      | merged length    |
| --------------------------------------------------------------- | ----------------- | ----------------- | ---------------- |
| packages/provider-opencode/src/server/driver.ts                 | none (978)        | none (884)        | 955              |
| packages/provider-opencode/src/server/v2/adapter.ts             | 4278              | 4237              | 4231             |
| packages/provider-opencode/src/server/adapter.ts                | 3761              | 3761              | 3758             |
| packages/provider-opencode/src/server/OpenCodeRuntime.ts        | 1118              | 1004              | 1004             |
| packages/provider-opencode/src/server/status.test.ts            | 1087              | 1087              | 814              |
| packages/provider-acp-registry/src/server/AcpRegistrySupport.ts | 1989 / nonNull 10 | 1989 / nonNull 10 | 1989 / nonNull 9 |
| packages/provider-pi/src/server/adapter.ts                      | 3476              | 3476              | 3469             |

Non-null counts of the opencode files are unchanged.

## Proof on the merged head (7d1a951e5d)

- Typecheck (`vp run typecheck`, uncached tsc-rs): packages/provider-opencode, provider-acp-registry, provider-pi, provider-core and apps/server each exit 0.
- `vp test run --maxWorkers=4`, every test file in each package: provider-opencode 41 files, 350 tests passed; provider-acp-registry 16 files, 102 passed and 2 skipped; provider-pi 21 passed and 1 skipped file, 247 passed and 1 skipped.
- apps/server `src/provider` plus the OpenCode adapter tests (`src/orchestration-v2/Adapters/OpenCode2AdapterV2*`, `OpenCode2Exit`): 146 files passed and 1 skipped, 1808 tests passed and 6 skipped.
- `vp lint` and `vp fmt` on the changed files: clean.
- `node scripts/goat-rename.ts --check`: exit 0, 0 lines with T3 residue in 0 files.
- `set -o pipefail; GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed origin/dev`, exit 1:

```
  pass  unused patches  1.0s
  pass  format  0.4s
  pass  lint  3.2s
  pass  knip 1/2  17.9s
  pass  knip 2/2  25.1s
  pass  graphql (apps/server)  2.1s
  pass  graphql (packages/source-control-github)  2.4s
  pass  agent surface audit  9.2s
  pass  agent context budget  8.5s
  pass  typecheck (42 packages)  26.1s
  FAIL  test (1727 files)  2236.5s
Test Files  3 failed | 1717 passed | 7 skipped (1727)
Tests  3 failed | 25626 passed | 24 skipped (25653)
```

The three failures are in files this merge does not change (no diff from either parent): packages/ssh/src/launchListenerScripts.test.ts (goat#3403, under full-run load; passes alone), packages/ssh/src/runtimeFactsScripts.test.ts (goat#3363, macOS /bin/bash 3.2; fails alone too), and apps/server/src/notes/NotesService.test.ts "recursive watcher observes an external edit and deletion through subscribe" (120 s timeout under load, load average about 7; the file passes alone, 36 of 36). The Notes watcher failure is goat#3411.

## NOT RUN

ci:full or hosted CI on this head; Windows; live OpenCode, Pi or Registry servers and providers; a server or real-client pass; a fail-first run (a merge; not needed).

Model: anthropic/claude-opus-5-5 via Codex in GOAT on juns-MacBook-Pro.
