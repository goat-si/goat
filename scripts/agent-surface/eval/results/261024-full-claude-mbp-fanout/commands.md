# 261024-full-claude-mbp-fanout: commands

Claude reference rerun of `fan-out-review` with the fixed runner (#1064), on the MacBook Pro.
One arm, `claude-full` (claudeAgent / claude-opus-4-8, listing full, `command_execution` and
`file_change` forbidden), task set v3, fixture and review models as in
`results/261023-full-claude/campaign.json`. A single-arm reference: no verdict, and it does not
decide D8. The approved cap was 50 Claude runs on eval threads, counting every follow-up run.

Measured code: origin/dev `0a2948fa4d9902a098894ec1bce074a5d988d388` (contains #1064,
`5521efc2b`), unmodified while the batch ran. Node v24.17.0, pnpm 12.14.0 (`vp install`).

## Dev server

Worktree-local home `<worktree>/.goat`, seeded read-only from `~/.goat/userdata/statev2.sqlite`
by dev-runner's first start (`migrate-dev-db`). Port 15950 (derived from the worktree path).
Session variables of the calling Codex thread were unset so provider children do not inherit them.
The Claude sign-in was used as found; no login, logout, or settings change.

```sh
UNSET="-u CODEX_THREAD_ID -u CODEX_SESSION_ID -u CODEX_TOOL_CALL_ID -u CODEX_CI \
  -u CODEX_INTERNAL_ORIGINATOR_OVERRIDE -u CODEX_MANAGED_BY_NPM -u CODEX_MANAGED_PACKAGE_ROOT \
  -u CODEX_VERSION -u CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS -u CLAUDE_AGENT_SDK_VERSION \
  -u GOAT_CLI_PATH -u ELECTRON_RUN_AS_NODE -u GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR"
env $UNSET node scripts/dev-runner.ts dev:server       # seeds <worktree>/.goat, serves :15950
```

dev-runner starts the server with `node --watch`. About 15 s into the first run it restarted
(`Restarting 'src/bin.ts'`, 07:20:34 KST) although no file under the worktree, including
`node_modules`, had a later mtime than the pre-run `context-budget.json`, and the provider logs
show the Claude run in `/tmp/goat-d8-claude-fanout/workspace` and the three reviews running no
commands. The likely cause is the watcher reacting when the server first loaded provider modules
that `vp install` had written minutes earlier; this was not proven. The rest of the batch ran on
the same server source without the watcher, with the environment dev-runner had given it:

```sh
cd apps/server && env $UNSET GOAT_HOME=<worktree>/.goat GOAT_MODE=web GOAT_NO_BROWSER=1 \
  GOAT_PORT=15950 PORT=7910 VITE_DEV_SERVER_URL=http://localhost:7910 \
  VITE_HTTP_URL=http://localhost:15950 VITE_WS_URL=ws://localhost:15950 node src/bin.ts
```

## Credentials (values never recorded)

```sh
# eval client: default scopes (orchestration:read, orchestration:operate), default
# runtime-mode ceiling approval-required; revoked after the batch
(cd apps/server && node src/bin.ts auth client create --base-dir <worktree>/.goat \
  --name d8-claude-fanout-eval-mbp --ttl 2d --token-only)
# setup client, used only for goat_project_create, then revoked
(cd apps/server && node src/bin.ts auth client create --base-dir <worktree>/.goat \
  --name d8-claude-fanout-setup --ttl 1h --runtime-mode-ceiling full-access --token-only)
(cd apps/server && node src/bin.ts auth client revoke --base-dir <worktree>/.goat <session id>)
```

## Eval project

`fan-out-review` uses a static fixture, so the project needs no fixture thread.

```text
goat_project_create { title: "d8-eval-claude-fanout-mbp",
  workspaceRoot: "/tmp/goat-d8-claude-fanout/workspace", createWorkspaceRootIfMissing: true }
                                                      -> mcp:dcfdbb28-d232-4302-9b86-d9247764caaa
```

## Campaign

`campaign.json` has `pairs: 1` and the runner was invoked once per measured run, so the Claude
run count could be read from the server before each run: a run started only while host pressure
was ok, no thread of the project was running, and the runs already used plus a worst case of 6
(launched run, four follow-ups, and one that may start before the stop) stayed within 50. Each
invocation is its own campaign id with pair 0; a single-arm report pools them.

```sh
R=scripts/agent-surface/eval/results/261024-full-claude-mbp-fanout
node scripts/agent-surface/eval/run.ts --campaign $R/campaign.json --tasks fan-out-review
# dry run: 1 plan step; skipped read-control, wait-running, launch-and-wait and the two manual tasks
node scripts/agent-surface/context-budget.ts --json > $R/context-budget.json   # before any run
# 11 times (the first was cut off by the restart, then 10 measured runs):
GOAT_EVAL_ENDPOINT=http://127.0.0.1:15950/mcp GOAT_EVAL_AUTHORIZATION="Bearer <eval token>" \
  node scripts/agent-surface/eval/run.ts --campaign $R/campaign.json --tasks fan-out-review \
  --live >> $R/runs.jsonl
node scripts/agent-surface/eval/report.ts --campaign $R/campaign.json \
  --budget $R/context-budget.json $R/runs.jsonl > $R/report.md
vp fmt $R/report.md
```

## Rows

`runs.jsonl` has 11 rows, unedited.

- `cmvlj9q1w` (thread `mcp:217eb18c-…`): contaminated, `runner: Error: tools/call: HTTP 503`
  from the watcher restart. Its first Claude run was cancelled by the restart; the thread went on
  to a second run and three reviews (luna completed, deepseek and sonnet interrupted) until it was
  stopped by hand with `goat_thread_interrupt { stopCascade: true }`; a third, queued run was
  cancelled. Its row records `cleanup.stopped: false` because the server was down at the time.
- The 10 measured runs: all clean and all successful. Every one started three reviews, ended its
  run, and answered in its fourth run (3 follow-up runs each). Model turns 6–8 to 9–11, median
  7 to 9.5; tool calls 5–7. Four runs had one failed call each,
  `goat_provider_list` `invalid_request` ("orchestrator_capabilities does not take args, so
  nothing ran. It takes search."). Every cleanup stopped with no unfinished delegated task.

## Model runs

Read back over the eval client after the batch (`goat_thread_list` with subagents and
`goat_thread_read` per thread); no thread was still running.

- Claude runs on eval threads: 43 of the 50 cap. 40 in the measured runs (4 each, all completed)
  and 3 in the contaminated one (1 cancelled by the restart, 1 interrupted, 1 queued and cancelled).
- Review children on the codex instance: gpt-6-luna 11 completed,
  command-code/deepseek-deepseek-v4.1-flash-fast 10 completed and 1 interrupted,
  anthropic/claude-sonnet-5-5 10 completed and 1 interrupted.
- Claude account usage from the live app's `goat_host_status` (cached readings): before, session
  0% and weekly 41% (22:20 UTC); after, session 12% (22:30 UTC; the weekly window was not in that
  reading).
- GOAT's run records carry no cost or token figures, so no cost is recorded here.
