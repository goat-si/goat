# next3 K3 · branch-only Git subscriptions

C4 wire-contract port for integration PR #3700. Lane base `f82d2df4b0`. Port in upstream ancestry order: `0d809db501`, `0ceaa9a48c`, `0ac41eecad`, `76e4cb5c8a`, `a3477a5dd93`.

## Compatibility and verification plan

- The descriptor's optional `vcsBranchStatus` capability opts a socket session into `subscribeVcsBranch({ cwd })` and `vcs.refreshBranch({ cwd })`. Keep the current status RPCs and payloads so older clients retain local and remote status. The new methods use the corresponding status scopes. Test denial and an old-client status call against the new server.
- With an older server, project branch labels from `subscribeVcsStatus({ cwd, includeRemote: false })` and skip branch refresh. Negotiate against the same session that executes the call. Reconnect through K7's subscription lifecycle, reevaluating capability on the replacement session. Cover mixed versions and reconnect in client-runtime tests.
- Web sidebar and search rows use branch-only leases, and mobile Branches uses the branch stream. Detailed Git surfaces retain full status. Branch-only demand must perform zero detailed reads and remote polls. Preserve GOAT's remote cache and auto-pull guards. An optional `isRepo` keeps ref-only messages decodable. Only explicit false clears the sidebar presentation of persisted branch and worktree labels, leaving persisted data intact.
- Resolve linked-worktree HEAD through GitWorkflowService. Share one scoped directory watcher per normalized checkout and refresh on atomic HEAD replacement. Stop when the Git admin directory disappears. Test shared teardown, index-lock recovery, PR cache consistency, no fetch/auto-pull, and the exact missing-repo payload. PR #3700 Windows CI must show that worktree removal during HEAD.lock churn emits missing-repo status and stops the watcher without spinning.
- Publish the fast HEAD read ahead of the detailed read. Exercise an in-flight slow status operation and check branch subscribers still get the latest HEAD.
- Run whole changed test files (server with `GOAT_TEST_TMP_GUARD=fail`) and `vp run check:changed origin/chase/t3-261114-next3` on Node 26.12.1 after integrating the latest base once. Live-client and hosted Windows proof belong to the integration pass. No dev server in this lane.
