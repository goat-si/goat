# Measuring the agent surface

[D8](../internals/agent-surface.md#decision-log) builds `goat_eval` opt-in and lets a paired
campaign of provider tasks decide whether it joins the core listing
([composition campaigns](#composition-campaigns)). The
separate `goat_screen_run` is bundled on this branch without that pre-ship gate.
This runner's provider tasks do not measure screen work; browser and desktop tasks
with observer-based oracles are measured by the [computer use eval](computer-use-eval.md).

The same runner checks the context diet's core listing against the full one
([listing campaigns](#listing-campaigns)). The task set, runner and report live in
[scripts/agent-surface/eval](../../scripts/agent-surface/eval/). The method is
summarized in [post-ship regression measurement](../internals/agent-surface.md#post-ship-regression-measurement).
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

Each row records `unknownOutcome` from `goat_eval` tool results, including follow-up runs.
Historical rows without this measurement cannot pass the composition gate.

Each failed tool call is recorded with its tool, error code, and message in `failedCalls`, so
an argument the server refused can be told apart from a tool the agent could not find.

Tool calls, result bytes, and wall time are recorded but never decide the listing gate; the
[composition gate](#composition-campaigns) also compares result bytes. The
[protocol](../internals/agent-surface.md#post-ship-regression-measurement) explains why. Result bytes
are the compact JSON the server returned to the run's tool calls. In Codex code mode a script
can keep a result out of the transcript, so there they count what was served, not what the
model read. First-prompt bytes come from
[context-budget.ts](../../scripts/agent-surface/context-budget.ts) run on the measured commit;
pass its `--json` output to the report with `--budget`.

### Composition campaigns

A campaign with `"gate": "eval"` decides whether `goat_eval` joins the core listing. The
baseline arm is the default core listing and the candidate is core plus `goat_eval`,
`{ "mode": "core_eval", "resident": ["goat_eval"] }`. That is the `agentToolListing` value that makes
`goat_eval` opt-in, so the runner switches it per run as for a listing campaign, on a provider without code
mode (Claude is the reference population). The prompt still names no tool.

The candidate passes when every one of these holds on one paired campaign (composition rule,
version 1, recorded as `COMPOSITION_RULE_VERSION` in the report):

- The control shows no gain, as for every gate, and its median turns rise by at most one at
  either end of the range.
- At least two of the three automatic multi-step tasks (`wait-running`, `fan-out-review`,
  `launch-and-wait`) show the reduction defined in [What is counted](#what-is-counted).
- On those tasks the median result bytes fall by at least a third. Without code mode, served
  bytes are what the model reads, so here they measure the claim that the server drops
  intermediate results.
- No task's failure rate rises, and no candidate run halts with `unknown_outcome`.

A failed campaign leaves `goat_eval` opt-in. Record the verdict and the results folder in the
D8 entry either way.

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
runner includes them only with `--include-manual`. D8's historical provider-sync
verdict requires those tasks; this does not gate `goat_screen_run`.

## Replaying tool-use mistakes

The separate [replay cases](../../scripts/agent-surface/eval/replay-cases.ts) cover review
rounds, async delegation, managed worktrees, PR ownership, thread links, and HTML preview.
They use invented histories adapted from upstream's tool-use regressions. They do not change
the paired campaign task set or count toward its gate.

Export a case with this checkout's GOAT instructions and the tools its thread listing serves:

```sh
node scripts/agent-surface/eval/replay-run.ts --case async-delegate-ends-turn --listing core --context
```

Repeat with `--listing full` to compare the two surfaces. Context generation uses the existing
inert catalog fixture; no installed GOAT server, credentials, provider, or captured harness
prompt is needed. The output is harness-independent GOAT context, not a complete Claude or
Codex request. An external harness supplies its native tools, honors the case's role and prior
turns, and records the new continuation. This command does not run that harness or simulate
future tool results.

Save the continuation as JSON with `version`, `caseId`, and `listing` from the exported context,
plus `calls`, `text`, and `stopReason`. Calls contain `tool`, object `input`, and optional
`isError` (set it to `true` for rejected calls). Record executed nested code-mode calls in order;
the grader does not execute or inspect JavaScript source. Include only the new continuation,
because setup calls cannot satisfy the case's requirements. For example:

```json
{
  "version": 3,
  "caseId": "async-delegate-ends-turn",
  "listing": "core",
  "calls": [
    {
      "tool": "mcp__goat__goat_call",
      "input": {
        "path": "task.create",
        "args": { "task": "Compare the cache designs", "mode": "async" }
      }
    }
  ],
  "text": "The research task is running; its result will arrive automatically.",
  "stopReason": "end_turn"
}
```

Grade it without calling a model or executing any replayed action:

```sh
node scripts/agent-surface/eval/replay-run.ts --case async-delegate-ends-turn --listing core --trace ../continuation.json
```

Exit 1 means a rule failed. `max_steps` and `error` stop reasons always fail. The grader checks
required and forbidden calls, partial arguments, ordering, call counts, shell patterns and
answer text. It resolves GOAT names through the current registry, accepts `goat_call` dispatch
in either listing, and rejects unknown paths or direct calls outside the selected listing.
These are behavioral checks on the supplied trace, not proof that its arguments passed the
server's schemas or that the requested work happened. Keep real transcripts and credentials
out of committed replay data. Changing a case or grading rule raises `REPLAY_VERSION`.

## Not yet possible

- This runner does not validate `goat_screen_run`; record screen-run
  evidence separately until a screen-task campaign is designed.
- The checks for the manual tasks (`providerReadyOnEveryHost`, `oneApprovalPerSync`,
  `oneHandoffPerHumanStep`) are not written, so the runner refuses those tasks.
- Model turns are a range until providers report requests per run.
