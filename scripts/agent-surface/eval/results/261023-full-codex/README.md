# Codex full-listing baseline, 2026-10-23

Phase 1 of the context diet's D8 measurement: the `codex` instance running
`anthropic/claude-opus-5-5` in code mode, on today's full `tools/list`, against a
dev server at dev `368b2c84a`. One arm, so [report.md](report.md) states numbers and no verdict.

- [campaign.json](campaign.json): arm, fixture model, review models, 12 pairs.
- [runs.jsonl](runs.jsonl): one row per run (48), the input to the report.
- [context-budget.json](context-budget.json): `context-budget.ts --json` on that commit.
- [superseded-read-control.jsonl](superseded-read-control.jsonl): the first 12 control runs,
  left out of the report. Their fixture picked a delegated review thread that
  `goat_thread_read` refuses, so 8 of 12 needed a second call. The fixture now skips
  subagents and confirms the thread reads; the control was re-run.

Reproduce, from a worktree at the commit that adds this directory:

```sh
vp run dev        # seeds <worktree>/.goat from a read-only copy of the live database
# outside any GOAT thread, from apps/server:
node src/bin.ts auth client create --base-dir <worktree>/.goat --name d8-eval \
  --scope orchestration:read --scope orchestration:operate \
  --runtime-mode-ceiling full-access --ttl 14d --token-only > <token file>
# create a project in an empty git directory and one completed non-eval thread in it,
# then set projectId in campaign.json
GOAT_EVAL_ENDPOINT=http://127.0.0.1:<server port>/mcp GOAT_EVAL_AUTHORIZATION="Bearer <token>" \
  node scripts/agent-surface/eval/run.ts --campaign scripts/agent-surface/eval/results/261023-full-codex/campaign.json --live > runs.jsonl
node scripts/agent-surface/eval/report.ts --campaign scripts/agent-surface/eval/results/261023-full-codex/campaign.json \
  --budget scripts/agent-surface/eval/results/261023-full-codex/context-budget.json scripts/agent-surface/eval/results/261023-full-codex/runs.jsonl > report.md
vp fmt report.md  # the committed copy is formatted; the numbers are unchanged
```
