# Next3 · TF1 · Dev tooling

Implementation base: 2c0e0002a996ec5d46c708919be5a43f579176fa. The assigned GOAT worktree started on `goat/upstream-catchup-tooling` at that exact integration tip. Created the requested `chase/t3-261114-next3-tf1` branch there. The brief contains GOAT issues and a GOAT tooling note, with no assigned upstream cherry-picks.

## Prior art and implementation plan

- #3542 (C1, shared test fixture). SQLite describes several independent sources of busy and checkpoint pressure. GOAT already recognizes the WAL-degraded message to settle a Deferred. Count that identity under the same logger, with an injected unrelated Warn and the original one-warning, frame counts and recovery assertions. [SQLite WAL](https://www.sqlite.org/wal.html#sometimes_queries_return_sqlite_busy_in_wal_mode)
- #3560 (C1, web browser test). The adjacent font case warms its lazy imports before rendering, and Vitest's wait has its own default deadline. Warm the preview, viewer and Pele flowchart modules before the same real render and interaction assertions. [Vitest waitFor](https://vitest.dev/api/vi#vi-waitfor)
- #3677 (C1, CI selection). GitHub offers the Windows image under an explicit label. Use GOAT's existing Windows suite and trigger lists to run the installer suite and to schedule Windows when its PowerShell source changes. [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- Per-file progress (C1, local gate). Vitest can choose its minimal reporter for agents. Select the default reporter explicitly and stream the output from test steps while other checks retain their grouped output. [Vitest reporters](https://vitest.dev/guide/reporters)
- #3688 (C2, local and CI test routing). Vitest sharding distributes files into separate invocations, and GOAT CI already runs broad related-server selections within the server package. Route changed server filters to the package for the local gate and hosted changed-tests launcher, retaining workspace and Node filters. [Vitest sharding](https://vitest.dev/guide/cli.html#shard)
- #3695 (C1, Pen test fixtures). Go's httptest holds its loopback listener open, and cancellation bounds blocking operations in the actual Coder WebSocket library. Keep the rejecting relay bound, let it report before the success path finishes, answer keepalive pings, and bound the session-cap script waits. [Go httptest](https://pkg.go.dev/net/http/httptest) · [Go context](https://pkg.go.dev/context#WithTimeout) · [Coder WebSocket](https://pkg.go.dev/github.com/coder/websocket)
- #3697 (C4, seeded workspace behavior). Git linked worktrees share ordinary refs, so moving a checkout to a linked worktree alone does not contain GOAT checkpoint writes. A distinct prefix still writes refs and objects to the original Git repository. [Git worktree refs](https://git-scm.com/docs/git-worktree#_refs) · [Git ref naming](https://git-scm.com/docs/git-check-ref-format)
- #3686 (C2, dev-runner server and Vite). Node watch restarts the entry point on changes to watched paths, and its filesystem notes describe macOS FSEvents and platform limitations. An explicit source-watcher opt-out preserves the supervised dev runner with manual restarts. [Node watch mode](https://nodejs.org/api/cli.html#--watch) · [Node fs.watch](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)

#3560 code-budget move claim: `AttachmentFilePreview.browser.test.tsx:1192–1257` (entry 2350); move the expanded Word fixture and its role data to adjacent `expandedWordPreview.testkit.ts`, leaving the consumers and assertions byte-identical. No test moves or retitles.

#3677 code-budget move claim: `.github/scripts/goat-ci-scope.test.cjs:35–44`, move the pure fake import graph builder into sibling `goat-ci-scope.testkit.cjs`. Callers and expectations stay in place.

## #3697 · Decision requested

What may a seeded environment write to the original project directory? Rekeying scopes or namespacing dev checkpoint refs prevents ordinal collision but still writes into the original repository and can leave a mixed history of live and dev checkpoint refs in the seed. Retargeting seeded projects to independent scratch clones contains writes and preserves the ability to exercise those projects, but needs a clone/copy policy for missing and dirty repositories, worktree paths, and historical checkpoint objects. Recommend preserving seeded history for inspection and requiring an explicit scratch project for writes first. A server-side refusal can retain the existing error shape for old web, desktop, and mobile clients; a newer client connected to an older server cannot count on this protection. A snapshot-local provenance marker can avoid changes to production rows or RPC payloads. Negative cases to settle include a pre-marker seed, symlink or linked-worktree aliases, restored/forked threads, automation starts, and a newly created scratch project that must still run.

#3613 is held for its own PR by its issue and next2 card. GOAT currently pins Effect 4.1.3 and Alchemy beta.85; the vendored package manifests on the base show Effect 4.0.1 and Alchemy beta.80. The two crypto comments are follow-ups in that same issue.

## Row verdicts

| Row | Verdict | GOAT commit |
| --- | --- | --- |
| #3655 | Already present. #3679 blocks worktree-local state in Metro. | `32bda9fca8c2b9cef319f61f669637b79b89e0aa` |
| #3613 | Skipped under the separate-reference-sync ruling. | — |
| #3542 | GOAT fix. Count WAL admission warnings and print captured warnings on count mismatch. | `9ce0e67027f821ad1dd5c292f55a8b2f19c7a9ef` |
| #3560 | GOAT fix. Warm real diagram modules before the test's render wait. | `6f0969d6ab85961332a51342d28181cb99848a2c` after move-only `593f115048dd14694c41f80639aaf366a1d3be29` |
| #3677 | GOAT fix. Windows source change schedules and runs the installer suite. | `0311b00d410c72d6c35aa3d1cf389a70a4968d95` after move-only `f2b6aaa79f32d1d98b0736079311e7ac2081ab5a` |
| Per-file progress | GOAT tooling. Test results stream as files finish. | `a5101a6bfa7da253703fc8c6c81c03fb55ce6ae8` |
| #3688 | GOAT fix. Sequential server-package and workspace batches reuse the same selected filters in local and hosted changed tests. | `9cb03fdd035d23f6beced171f57806d55d9feeb4` |
| #3695 | GOAT test-fixture fixes. | `16c50862ddf46132c91317e522be037bbf7599b5` |
| #3697 | Decision. See the compatibility and negative cases above. | — |
| #3686 | GOAT fix. Opt out of server and web source watchers when doing a dev client pass. | `6def29ca359f546e50dcd731a6364e3f0d575545` |

GOAT-side review range `2c0e0002a996ec5d46c708919be5a43f579176fa..6def29ca359f546e50dcd731a6364e3f0d575545` (nine commits including two move-outs). Clean upstream cherry-picks: none. The final `git fetch origin; git merge origin/chase/t3-261114-next3` reported `Already up to date` at integration head `2c0e0002a996ec5d46c708919be5a43f579176fa`. Lockfile diff empty.

### Newer upstream overlap (93cbca3fcbd..8a6342e7613)

- Mermaid attachment suite #3560: `055b44919ee`, `2370e338f73`, `2afee520252`, `85e009fbc99`, `31d9b3bcd60`.
- Local changed-test runner and progress: `97edb7ad42a` (Git ignored-file scan on Windows). #3688 generated-schema overlap: `ea6d3fc30fb` (Codex speed protocol).
- Dev-runner watchers #3686 and direct touched manifests/config: `d085ee5d155`, `86863beedef`, `1d20ad013f4`, `0b308312d53`, `b64eebb991b`, `f12527ecf0e`, `2b6145b4c81`.
- Remaining rows returned no hits for their GOAT-owned code paths and direct candidate files.

### Reproduction and CI handoff

- #3542 pre-fix `vp test run packages/shared/src/nodeSqliteWriter.test.ts`: exit 1, 26 pass and the injected unrelated Warn reproduced the 2-versus-1 diagnostic.
- #3560 pre-fix `vp test run apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx`: exit 0, 111 passed. The original cold failure is the linked hosted CI report in the issue.
- #3677 pre-fix `vp exec node --test .github/scripts/goat-ci-scope.test.cjs`: exit 1, 73 pass and installer selection failed.
- #3688 pre-fix `vp test run scripts/lib/split-tests.test.ts`: exit 1, 1 pass and 1 failed on the single workspace batch. PR #3700 must show a wide server selection collecting and executing at the exact integration head in the server-package job or related shards, and the changed-test host runner collecting all selected files without a generated-schema load overflow.
- #3695 PR #3700 must show `goat-test-pen-windows` on hosted `windows-2025` passing `go -C apps/pen test -count=1 ./...` including both cli and relay packages. The pipe trace must cover the rejected dial and the winning relay's first byte. The cap test must see CLOSE 4429, release a slot and accept the next OPEN. The slot or relay failure should be diagnosed by the 20-second bound if it recurs.
- #3677 PR #3700 `goat-test-windows` must show `scripts/install-windows.test.ts` executed on Windows.
- #3686 pre-fix `vp test run scripts/dev-runner.test.ts`: exit 1, 35 pass and CLI rejected `--no-watch`. Two brief sessions ran `vp run dev --home-dir <disposable-dir> --no-seed` with SSH and telemetry off. A 60-file link/unlink metadata burst left git clean and caused `Restarting 'src/bin.ts'` with the server PID changing from 18971 to 27093. Repeating with `--no-watch` produced zero restart/reload lines, with unchanged server/web PIDs 59561/59547 and HTTP 302/200. Vite emitted no reload in the baseline probe. Both sessions stopped on their own PTYs and the disposable homes were removed.
- P1: verify an iOS/Android client stays usable and keeps its connection during an isolated `--no-watch` pass (#3686), and stays responsive when ordinary dev writes occur under the worktree's .goat (#3655, already landed). A Replay turn uses a freshly created scratch Git project (#3697). No user-facing runtime code changed for #3560.

## Checks at the lane head

- `vp run check:changed origin/chase/t3-261114-next3`: exit 0. 2,176 Vitest tests across eight files and 74 node:test cases in one file. Zero failures and skips. Format, lint, both knip passes, unused-patches check, GraphQL generation check, both agent-surface checks and typecheck across 42 packages passed. The test steps printed individual file results before the final summary.
- `GOAT_TEST_TMP_GUARD=fail vp exec node scripts/run-changed-vitest.ts apps/server/src/http.test.ts apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx packages/shared/src/nodeSqliteWriter.test.ts scripts/dev-runner.test.ts scripts/lib/split-tests.test.ts scripts/check-changed.test.ts`: exit 0. 42 in `http.test.ts` from `apps/server`, then 179 in the workspace (111 attachment preview, 27 SQLite writer, 36 dev runner, 2 split tests, 3 check-changed checks). The whole `.github/scripts/goat-ci-scope.test.cjs` ran in the lane gate, 74 passed. No changed Vitest server test files.
- `git diff --check origin/chase/t3-261114-next3 HEAD` and `gofmt -l apps/pen/internal/cli/pipe_test.go apps/pen/internal/relay/relay_test.go`: exit 0, no output. Both move-first fixture blocks match the base after stripping export wrappers.
- During development the first gate exited 1 on two Effect console diagnostics in the standalone runner, with all 2,250 tests passing. The runner now writes to stdout/stderr directly and preserves GitHub's annotation reporter. The final gate reran at the lane head above.

NOT RUN: PR #3700 CI, wide overflow reproduction, hosted Windows installer or Pen Go suite, P1 client pass, shared-tailnet --built and Electron dev watcher smoke, repo-wide checks. No lane PR or CI dispatch.
