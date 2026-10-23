# 261023-full-claude-mbp: commands

Claude arm of the D8 full-listing baseline, run on the MacBook Pro because the
clisu-oracle Claude sign-in returned 401. Settings follow
`results/261023-full-claude/campaign.json` on clisu-oracle, with the task set narrowed by the
program manager to `read-control,wait-running,fan-out-review` at 10 pairs (30 Claude runs, the
approved cap). `launch-and-wait` runs on Codex only, on clisu-oracle.

Measured code: `bb7f97ae2b76c28d35649f2ff9e89976903a289d` (feat/context-diet-d8), unmodified
while the batch ran. Node v24.17.0, pnpm 12.14.0.

## Dev server

Worktree-local home `<worktree>/.goat`, seeded read-only from `~/.goat/userdata/statev2.sqlite`
by `migrate-dev-db` (it clears scheduled tasks, live threads and auth sessions). Server only,
port 14552 (derived from the worktree path). Codex session variables of the calling thread were
unset so provider children do not inherit them.

```sh
env -u CODEX_THREAD_ID -u CODEX_SESSION_ID -u CODEX_TOOL_CALL_ID -u CODEX_APP_TOOLS_PIPE_PATH \
  -u CODEX_CI -u CODEX_INTERNAL_ORIGINATOR_OVERRIDE -u CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY \
  -u CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE -u CODEX_SHELL -u CLAUDE_AGENT_SDK_VERSION -u GOAT_CLI_PATH \
  node scripts/dev-runner.ts dev:server
```

## Credentials (values never recorded)

```sh
# eval client: default scopes (orchestration:read, orchestration:operate),
# default runtime-mode ceiling approval-required
(cd apps/server && node src/bin.ts auth client create --base-dir <worktree>/.goat \
  --name d8-claude-eval-mbp --ttl 2d --token-only)
# setup client, used only for goat_project_create and the read-control fixture thread, then revoked
(cd apps/server && node src/bin.ts auth client create --base-dir <worktree>/.goat \
  --name d8-setup-admin --ttl 1h --runtime-mode-ceiling full-access --token-only)
(cd apps/server && node src/bin.ts auth client revoke --base-dir <worktree>/.goat <setup session id>)
```

## Eval project and read-control fixture

The seeded projects point at live checkouts, so the campaign uses its own project with workspace
`/tmp/goat-d8-claude/workspace`. Its one completed non-`[eval` thread is the read-control
fixture, run on the fixture model:

```text
goat_project_create { title: "d8-eval-claude-mbp", workspaceRoot: "/tmp/goat-d8-claude/workspace",
  createWorkspaceRootIfMissing: true }                -> mcp:9d035b05-1f76-4a63-9152-b545e1cb0fa6
goat_thread_launch { title: "D8 read-control fixture", projectId, message: "Reply with the single word: done",
  modelSelection: { instanceId: "codex", model: "gpt-6-luna" }, notifyOnCompletion: false }
                                                      -> mcp:7f7eef3d-f7d0-4153-98f0-33143ae14cad, completed
```

## Campaign

```sh
R=scripts/agent-surface/eval/results/261023-full-claude-mbp
node scripts/agent-surface/eval/run.ts --campaign $R/campaign.json \
  --tasks read-control,wait-running,fan-out-review
# dry run: 30 plan steps, 10 per task; skipped launch-and-wait and the two manual tasks
GOAT_EVAL_ENDPOINT=http://127.0.0.1:14552/mcp GOAT_EVAL_AUTHORIZATION="Bearer <eval token>" \
  node scripts/agent-surface/eval/run.ts --campaign $R/campaign.json \
  --tasks read-control,wait-running,fan-out-review --live > $R/runs.jsonl
```

## Context budget

`context-budget.ts` is not on bb7f97ae2. It was run from a clean detached worktree of
bb7f97ae2 with `scripts/agent-surface/context-budget.ts` and `servedCatalog.ts` copied
untracked from origin/dev `6c70a3207` (#958). The script builds the served catalog in-process
at the checked-out commit; its `dirty: false` ignores those two untracked files.

```sh
node scripts/agent-surface/context-budget.ts --json > $R/context-budget.json
```

## Report

```sh
node scripts/agent-surface/eval/report.ts --campaign $R/campaign.json \
  --budget $R/context-budget.json $R/runs.jsonl > $R/report.md
```

## After the batch

The runner exited 0 with 30 rows. Read back over the eval client afterwards:

- Every fan-out-review thread got later Claude runs on claude-opus-4-8 that the runner does
  not measure: completion notices from the three delegated reviews woke the thread. 25 such
  runs (23 completed, 2 cancelled), so the eval threads ran 55 Claude runs in total. None was
  still running when the batch ended, so none was interrupted.
- In 8 of 10 fan-out-review runs (pairs 1, 3-9) the measured run started the three reviews,
  ended its turn without an answer, and gave the EVAL_JSON line in a later woken run (run 3 or
  4). The row records "0 EVAL_JSON lines" because only the launched run counts.
- In pairs 0 and 2 the measured run waited and answered, but reported each review's model as
  "codex / <model>" (the instance / model form the prompt lists); the check compares it with
  the run's model id alone.
- Other model runs: wait-running started 30 fixture threads and fan-out-review 30 delegated
  reviews on the codex instance (10 each on gpt-6-luna,
  command-code/deepseek-deepseek-v4.1-flash-fast and anthropic/claude-sonnet-5-5), plus the
  one read-control fixture thread.
- GOAT's run records carry no cost or token figures, so no cost is recorded here.
