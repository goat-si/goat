# Measuring the agent surface (D8)

[D8](../internals/agent-surface.md#decision-log) builds `goat_eval` only if agents on
providers without code execution need at least a third fewer model turns with it than with
`goat_call` alone, with no rise in failed runs. The same runner checks the context diet's
core listing against the full one and decides which tools stay resident
([listing campaigns](#listing-campaigns)). This page explains how to run both
measurements. The task set, runner, and report live in
[scripts/agent-surface/eval](../../scripts/agent-surface/eval/). The reasons behind the method
are in the [measurement protocol](../internals/agent-surface.md#measurement-protocol-draft), which
follows aside-codemode's
[paired runs](https://github.com/lidge-jun/aside-codemode/blob/b395d89/eval/paired-run.mjs).
Results live beside their raw rows in [results](../../scripts/agent-surface/eval/results/).

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
| `launch-and-wait`         | Start one thread on a given model, wait for it, and report its status  | fewer   | automatic |
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

A verdict comes only from one campaign that ran both arms, because ABBA pairs runs within a
campaign; the report refuses a verdict from rows of two campaigns and refuses a run that
appears twice or ran something its arm does not state. A campaign with one arm, rows pooled
from several campaigns, or rows from an older task set give reference numbers, and the report
labels them "Reference, not paired".

### Listing campaigns

A campaign with `"gate": "listing"` compares what `tools/list` serves: `{ "mode": "full" }`
against `{ "mode": "core", "resident": [...] }`, where the core always holds `goat_describe`
and `goat_call` and `resident` names the other tools the registry lists as core. The listing
is the server setting `agentToolListing`, so both arms share one provider instance. With
`listingSettings` set to the eval server's `settings.json`, the runner writes each run's
listing there before launching it; the server reloads the file. Either way it then lists tools
with its own client and reads from the result the listing agents get, since clients themselves
keep the full listing (D22 in [agent-surface.md](../internals/agent-surface.md)). It records
that as `observedListing` and marks the run contaminated when it is not the arm's listing. A
harness can only call what it was listed, so a core arm that calls any other GOAT tool
directly is contaminated too. Which tools are resident is the
registry's `listing: "core"` field, so a "core plus one tool" arm needs a server built with
that change; it is not a campaign setting.

Here the `no_gain` task is the single-call control and every other task counts
as multi-step. The control passes when the candidate's median turns rise by at most one at
either end of the range; a multi-step task passes when they do not rise at either end. Either
fails when the candidate fails more often. Both ends are compared like for like, because both
arms are counted the same way.

A resident candidate can only show a saved turn on a task that calls it. `launch-and-wait`
calls `goat_thread_launch` and `fan-out-review` calls `goat_task_create`. No task calls
`goat_origin_report`, because a thread launched by the runner's client credential has no
origin to report to, or `goat_preview_snapshot`, which needs a browser the dev server can
start.

## What is counted

GOAT does not record how many model requests a run made. Calls a model makes in one response
appear as consecutive timeline items. The runner therefore reports model turns as a range:
tool rounds + 1 at the low end, where consecutive tool items count once, and tool calls + 1 at
the high end. A reduction counts only when the candidate's high end is at least a third below
the baseline's low end, so the gate holds whatever the true counts were. This is strict on
purpose. It relaxes only when providers report requests per run.

A run fails when it does not complete before its deadline, when its final reply lacks exactly
one `EVAL_JSON` line with the task's keys, or when a check disagrees with the server. Failed
runs stay in the failure rate. Medians come from successful runs, because a run that gave up
early would look cheap. Each task needs at least ten successful clean runs per arm. A tool call
that failed and was retried is not a failed run: its extra turns stay in the counts, and the
report shows failed calls per arm. The gate also fails if the control shows a gain.

An agent that delegates may end its run and answer in a later one, started when a delegated
child's delivery wakes the thread. A run therefore counts the launched run and each later run
of the eval thread until the first `EVAL_JSON` answer, or until the thread is quiet with no
unfinished delegated task, at most four later runs; past that it fails with `followup_cap`.
Turns, calls, and result bytes are summed over the counted runs, and the row records
`followupRuns`. Then the runner stops the thread the way GOAT's Stop does (`stopCascade`): its
queue is held and its delegated tasks stop, so no wake-up run follows that nobody measures. The
row's `cleanup` lists the delegated tasks that were still unfinished.

Each failed tool call is recorded with its tool, error code, and message in `failedCalls`, so
an argument the server refused can be told apart from a tool the agent could not find.

Tool calls, result bytes, and wall time are recorded but never decide the gate; the
[protocol](../internals/agent-surface.md#measurement-protocol-draft) explains why. Result bytes
are the compact JSON the server returned to the run's tool calls. In Codex code mode a script
can keep a result out of the transcript, so there they count what was served, not what the
model read. First-prompt bytes come from
[context-budget.ts](../../scripts/agent-surface/context-budget.ts) run on the measured commit;
pass its `--json` output to the report with `--budget`.

## Running a campaign

Run campaigns only against a dev server with seeded data, started with `vp run dev` in a
worktree, and never against the live install. Fixtures and runs launch real threads, and the
runner does not delete them. The dev server restarts when server or package source changes, so
leave that worktree's source alone while a batch runs.

1. Copy [campaign.example.json](../../scripts/agent-surface/eval/campaign.example.json) and fill
   in the project, the arms, a cheap fixture model, and three review models. Mint the client
   credential with `goat auth client create --base-dir <worktree>/.goat` outside any thread.
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
   node scripts/agent-surface/eval/report.ts --campaign ../campaign.json \
     --budget ../context-budget.json ../runs.jsonl
   ```

Commit each campaign as `results/<yymmdd>-<name>/` with `campaign.json`, `runs.jsonl`,
`context-budget.json`, and the generated `report.md`, so a disputed figure can be re-derived.
They name dev-server threads and provider instances only; never commit a credential. Record the
conclusion and a link to the evidence in the D8 entry of the decision log.
Raw rows are never edited: a row a later fix can judge again goes into a derived file beside
it, with the command that made it, and a row it cannot is marked superseded.

The manual tasks need connected hosts and a person who approves or finishes sign-in, and the
runner includes them only with `--include-manual`. D8 names provider sync, so the gate
cannot pass until those tasks have run.

## Not yet possible

- No server lists `goat_eval` yet ([rollout](../internals/agent-surface.md#rollout) step 11),
  and none can hide it per provider instance. Until a prototype provides both, only the
  baseline arm can run. That yields baseline numbers but no verdict.
- Until the `agentToolListing` setting is on dev, a listing campaign can run only its full arm.
- The checks for the manual tasks (`providerReadyOnEveryHost`, `oneApprovalPerSync`,
  `oneHandoffPerHumanStep`) are not written, so the runner refuses those tasks.
- Model turns are a range until providers report requests per run.
