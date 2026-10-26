# Codex full vs core listing, 2026-10-23

The paired D8 listing campaign: one ABBA campaign (`cmvl7drv2`), arms `full` and `core`, both on
the `codex` instance running `anthropic/claude-opus-5-5` in code mode, 10 pairs per automated task,
one run at a time. The server's `agentToolListing` (#1026) was switched before every run, and
every row's `observedListing` shows what `tools/list` gave the runner's client: 147 tools for
`full`, `goat_describe` and `goat_call` for `core`. The verdict is in [report.md](report.md).

- [campaign.json](campaign.json), [runs.jsonl](runs.jsonl) (80 rows), [report.md](report.md).
- [context-budget.json](context-budget.json): `context-budget.ts --json` on the measured commit;
  it measures the full listing only.

Two `core` fan-out-review runs (pairs 1 and 5) are contaminated: the agent read the thread's own
MCP credential from `GOAT_ACP_MCP_*` in its environment. In pair 1 it then wrote a curl wrapper
and called unlisted tools by name (`goat_provider_list`, `goat_task_create`, `goat_task_read`)
through `/mcp`; pair 5 ran only that env read. The campaign rules leave both out of every median.

Reproduce, from a worktree at the commit that adds this directory, on Node 24.16 or later:

```sh
vp run dev        # seeds <worktree>/.goat from a read-only copy of the live database
# outside any GOAT thread, from apps/server:
node src/bin.ts auth client create --base-dir <worktree>/.goat --name d8-eval \
  --scope orchestration:read --scope orchestration:operate \
  --runtime-mode-ceiling full-access --ttl 14d --token-only > <token file>
# create a project in an empty git directory with one completed non-eval thread, then set
# projectId and listingSettings (<worktree>/.goat/userdata/settings.json) in campaign.json
node scripts/agent-surface/context-budget.ts --json > scripts/agent-surface/eval/results/261023-listing-codex/context-budget.json
GOAT_EVAL_ENDPOINT=http://127.0.0.1:<server port>/mcp GOAT_EVAL_AUTHORIZATION="Bearer <token>" \
  node scripts/agent-surface/eval/run.ts --campaign scripts/agent-surface/eval/results/261023-listing-codex/campaign.json --live > scripts/agent-surface/eval/results/261023-listing-codex/runs.jsonl
node scripts/agent-surface/eval/report.ts --campaign scripts/agent-surface/eval/results/261023-listing-codex/campaign.json \
  --budget scripts/agent-surface/eval/results/261023-listing-codex/context-budget.json scripts/agent-surface/eval/results/261023-listing-codex/runs.jsonl > scripts/agent-surface/eval/results/261023-listing-codex/report.md
vp fmt scripts/agent-surface/eval/results/261023-listing-codex/report.md  # the committed copy is formatted; the numbers are unchanged
```
