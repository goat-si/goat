# Dev merge lane for PR #3700

Merge commit `064e687d65aa4a35873e64ae69ac74435566e081` on `chase/t3-261114-next3-devmerge1`. First parent `cf1e3679e3aed1c45d8bdc28d310937ca9712846` is the integration head. Second parent `a4392efb38be89453d59e70db04e4251ad9ae971` is `origin/dev`, which brought in #3150, #3718, #3717, #3715, #3712, #3709, #3708 and #3707. The lane checkout started behind the requested first parent at `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2` and was fast-forwarded before merging.

## Conflicts and compatibility

All six conflicts were under `apps/server/src/persistence/`.

| Conflict                                                     | Resolution                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Migrations.ts:172` and `:341`                               | Keep the released `158_AuthSessionPenMember.ts` and register the renamed `159_ScheduledTaskFirstBindIntent.ts` immediately after it. Byte comparisons against the respective parents matched both migration bodies. |
| `reconcileGoatMigrationIds.ts:80`                            | Keep both migration names in `GOAT_MIGRATION_NAMES`, in ledger order.                                                                                                                                               |
| `reconcileGoatMigrationIds.resume.test.ts:236`               | Keep the crash fixture pinned to `DisposableMachineEnrollment`. Expect both later rows on resume and retain the expected ledger and error checks after partial upgrades.                                            |
| `reconcileGoatMigrationIds.test.ts:576`                      | Assert the ordered 158 and 159 tail on the nightly 256 upgrade.                                                                                                                                                     |
| `reconcileGoatMigrationIds.upstream080.test.ts:39` and `:85` | Keep the ledger, rollback, rerun and id-shift scenarios from both sides. Assert the ordered tail and exercise a dev nightly ledger ending at 158.                                                                   |
| `reconcileV2PreviewMigration.test.ts:175` and `:359`         | Keep both rows, in order, in each preview upgrade ledger.                                                                                                                                                           |

`apps/server/src/scheduledTasks/ScheduledTaskRuns.test.ts:80` verifies that a database through 157 applies 158 and 159 in order, preserves a pre-existing firing and still accepts an older writer. Its failure case at `:127` verifies that a failed 159 rolls back its column and ledger row, retains 158 and can rerun. The dev nightly case verifies that reconciliation leaves the existing ledger intact, applies only 159 and reaches the same schema and ledger as a fresh database. SF4-only 158 stayed unreleased on PR #3700, so the merge carries no upgrade path for that layout.

## Verification

Used Node `26.12.1`, bundled SQLite `3.54.0` and Git `2.43.0`. `vp i` exited 0 after the auto-merged lockfile added two workspace links to `@goat/pen-protocol`. Format and lint hooks passed. `git diff --check HEAD^1 HEAD` and `git diff --check HEAD^2 HEAD` exited 0.

The guarded command from `apps/server` was `GOAT_TEST_TMP_GUARD=fail VP_NODE_VERSION=26.12.1 vp env exec --node 26.12.1 -- vp test run --reporter=default <whole files>`. It exited 0 with 441 passes, zero failures and zero skips across 86 files. That includes 276 tests across all 75 persistence files and 165 tests across 11 scheduled-task files. `Migrations/129_ScheduledTaskRuns.test.ts` is included in the persistence count. The pinned runtime was confirmed in the Vitest launcher and workers. An initial bare `vp test` selected Node 26.13.1 and SQLite 3.54.1 from the server package's wider engine range. It produced one migration 026 failure, where a model's `options` came back as a JSON string. The same test passed with the requested Node pin in both gates.

`node scripts/check-changed.ts origin/chase/t3-261114-next3` exited 1. The command compared 191 changed paths to the first parent, with `VITEST_MAX_WORKERS=6`. A temporary Node preload removed only the 348 selected `*.browser.test.*` files from Vitest's input. The checkout and its gate scripts stayed clean. The rename audit, unused-patch check, format, lint, both Knip passes, GraphQL generation, agent-surface audit, agent context budget and typecheck across 42 packages passed.

| Changed-files batch | Files | Tests passed | Tests failed | Tests skipped |
| ------------------- | ----: | -----------: | -----------: | ------------: |
| Server              | 1,553 |       19,238 |            1 |            20 |
| Workspace           | 1,093 |       16,116 |           29 |             4 |
| Total               | 2,646 |       35,354 |           30 |            24 |

### First-parent comparison

On `cf1e3679e3aed1c45d8bdc28d310937ca9712846`, reran all eight failing files whole on pinned Node 26.12.1. The server invocation exited 1 with 10 passed and 1 failed. The workspace invocation exited 1 with 117 passed and 29 failed. Both reported zero skips. All 30 failing test titles and error messages matched the merge run after normalizing SSH fixture paths and PIDs. No failures were unique to either run.

| Failures | Files and evidence                                                                                                                                                                                                                                                   |
| -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|       23 | `packages/ssh/src/tunnel.protocol-forced.test.ts` (10) and `tunnel.protocol-forced-followup.test.ts` (13). The same fixture trust failures reproduced on both heads, including refusal when the temporary `.goat/ssh-launch` can be changed by another user.         |
|        1 | `packages/provider-grok/src/server/driver.test.ts:152`. The PATH test expected `/new/bin` and received `undefined` on both heads.                                                                                                                                    |
|        1 | `apps/server/src/storageCleanupShipping.test.ts:211`. On Git 2.43.0, both runs kept the worktrees and reported “Default branch is unavailable” where the test expected “Couldn't refresh origin/main.” The expected and received reason pairs matched byte for byte. |
|        4 | `infra/relay/src/agentActivity/ApnsDeliveries.test.ts` (1) and `FcmDeliveries.test.ts` (2), and `infra/relay/src/environments/EnvironmentLinks.test.ts` (1). All four failed at the PostgreSQL fixture's missing-binary check.                                       |
|        1 | `scripts/setup-worktree.test.ts`, “refuses when no installer is present.” Both heads reported installation starting in stderr, where the test expected `pnpm 12.14.0`.                                                                                               |

NOT RUN: 348 browser files, live client passes, separate full CI, builds, release checks, and independent C4 review for landing PR #3700. The unreleased SF4-only 158 ledger was outside the compatibility scope.
