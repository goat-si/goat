# Measuring `goat_eval`

[D8](../internals/agent-surface.md#decision-log) builds `goat_eval` only if agents on
providers without code execution need at least a third fewer model turns with it than with
`goat_call` alone, with no rise in failed runs. This page explains how to run that
measurement. The task set, runner, and report live in
[scripts/agent-surface/eval](../../scripts/agent-surface/eval/). The method is adapted from
aside-codemode's paired runs
([paired-run.mjs](https://github.com/lidge-jun/aside-codemode/blob/b395d89/eval/paired-run.mjs),
[PROTOCOL.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/bench-260918/PROTOCOL.md)).
No campaign has run yet, so this page states no results.

## The task set

[tasks.json](../../scripts/agent-surface/eval/tasks.json) is fixed and versioned. Changing a
prompt, fixture, or check raises the version, and the report refuses to pool rows from two
versions. Each task states its claim and what would falsify it, and each has a check that
compares the agent's answer with server state. A run that only reaches the end of its
transcript has not passed.

| Task                      | Asks the agent to                                                      | Claim   | Runs      |
| ------------------------- | ---------------------------------------------------------------------- | ------- | --------- |
| `read-control`            | Report one thread's title                                              | no gain | automatic |
| `wait-running`            | Wait for three just-started threads and report each final status       | fewer   | automatic |
| `fan-out-review`          | Run one review each on three models as delegated tasks and report them | fewer   | automatic |
| `provider-sync-all-hosts` | Make a provider ready on every connected host                          | fewer   | manual    |
| `human-step-resume`       | Set up a provider when a person has to finish sign-in                  | fewer   | manual    |

The control is expected to show no gain, because one read is one call in either arm. If it
shows a gain, the count is measuring something other than composition, and the report marks
the control as suspect.

## Arms

A campaign compares two arms. They use the same provider, model, prompt, and answer contract,
and they differ only in the tool listing: the baseline lists `goat_call` without
`goat_eval`, and the candidate lists both. Both arms run on a provider instance without
code execution, because that is the population D8 is about. Harnesses that run code, such as
Codex code mode, already compose calls themselves. To measure one as a reference, run it as a
separate campaign against the baseline. Its result does not count toward the gate.

The prompt never names tools. The listing has to come from the server, through whatever
per-instance switch the prototype provides. After each run, the runner reads the timeline and
marks a run contaminated when it called a tool its arm does not list, ran a command or edited a
file, or produced an item kind the runner cannot classify. Contaminated runs appear in the
report with their reason and are left out of every ratio, so a misconfigured arm cannot pass
as a measurement.

## What is counted

GOAT does not record how many model requests a run made. Calls a model makes in one response
appear as consecutive timeline items. The runner therefore reports model turns as a range:
tool rounds + 1 at the low end, where consecutive tool items count once, and tool calls + 1 at
the high end. The gate requires the one-third reduction at both ends, so neither parallel calls
nor merged rounds can produce a pass on their own.

A run fails when it does not complete before its deadline, when its final reply lacks exactly
one `EVAL_JSON` line with the task's keys, or when a check disagrees with the server. Failed
runs stay in the failure rate. Medians come from successful runs, because a run that gave up
early would look cheap. Each task needs at least ten clean runs per arm.

Tool calls, tool output size, and wall time are recorded but never decide the gate. In
aside-codemode's agent runs, roughly 8 s of fixed cost per model turn hid primitives that were
seconds faster: wall-time ratios ranged from 0.553 to 0.952 against a target below 0.5, while
call counts and bytes in context fell sharply
([summary.md](https://github.com/lidge-jun/aside-codemode/blob/b395d89/evidence/summary.md)).

## Running a campaign

Run campaigns only against a dev server with seeded data, started with `vp run dev` in a
worktree, and never against the live install. Fixtures and runs launch real threads, and the
runner does not delete them.

1. Copy [campaign.example.json](../../scripts/agent-surface/eval/campaign.example.json) outside
   the repository and fill in the project, the two arms, a cheap fixture model, and three review
   models.
2. Check it without contacting a server. This prints the ABBA schedule and every skipped task
   with its reason:

   ```sh
   node scripts/agent-surface/eval/run.ts --campaign ../campaign.json
   ```

3. Run it with an MCP client credential for that dev server. The runner does not fall back to
   a thread's `GOAT_ACP_MCP_*` credential, because runs launched under a thread count
   against that thread's lanes and ceiling:

   ```sh
   GOAT_EVAL_ENDPOINT=http://127.0.0.1:<port>/mcp GOAT_EVAL_AUTHORIZATION="Bearer <token>" \
     node scripts/agent-surface/eval/run.ts --campaign ../campaign.json --live > ../runs.jsonl
   ```

4. Build the report from the raw rows:

   ```sh
   node scripts/agent-surface/eval/report.ts --campaign ../campaign.json ../runs.jsonl
   ```

Keep campaign files, raw rows, and reports out of the repository, since they name machines,
providers, and threads. Record the conclusion and a link to the evidence in the D8 entry of the
decision log.

The manual tasks need connected hosts and a person who approves or finishes sign-in, and the
runner includes them only with `--include-manual`. D8 names provider sync, so the gate
cannot pass until those tasks have run.

## Not yet possible

- No server lists `goat_eval` yet ([rollout](../internals/agent-surface.md#rollout) step 11),
  and none can hide it per provider instance. Until a prototype provides both, only the
  baseline arm can run. That yields baseline numbers but no verdict.
- The checks for the manual tasks (`providerReadyOnEveryHost`, `oneApprovalPerSync`,
  `oneHandoffPerHumanStep`) are not written, so the runner refuses those tasks.
- Model turns are a range until providers report requests per run.
