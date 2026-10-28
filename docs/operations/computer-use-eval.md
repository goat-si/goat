# Measuring computer use

The computer use eval runs the same small, public tasks through GOAT and through the computer
use tools of other products on one Mac, and scores each arm from what an independent observer
saw, not from what the agent said. It exists so the targets for speed, browser work and model
guidance are tracked with numbers. The task set, runner and scoring live in
[scripts/computer-use-eval](../../scripts/computer-use-eval/); results are kept outside the
repository.

## Tasks

[tasks.json](../../scripts/computer-use-eval/tasks.json) is versioned. Changing a prompt, an
expected value or an oracle raises the version, and runs of two versions are not compared.

| Task                      | The agent                                                                       | Judged by                    |
| ------------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `calculator-multiply`     | enters 987 × 65 in the open Calculator, reads it, resets the display            | Calculator's display         |
| `finder-sidebar`          | opens a new Finder window, visits Downloads then Recents, closes it             | Finder window ids and titles |
| `textedit-korean-discard` | types a Korean sentence in a new TextEdit document, closes it unsaved           | TextEdit text, new files     |
| `kakaotalk-tabs`          | switches KakaoTalk between Friends and Chats and back, or skips when signed out | KakaoTalk windows            |
| `web-add-remove`          | clicks Add Element 8 times and counts the Delete buttons                        | tool results                 |
| `web-checkboxes`          | toggles both checkboxes and reads their state                                   | tool results                 |
| `web-form`                | fills a public form without submitting it and reads the values back             | tool results                 |
| `web-parallel-read`       | reads two public pages and reports their titles                                 | tool results                 |

Every answer ends with an `EVAL_JSON` line whose `status` is `done`, `failed` or `skipped`.

## Arms

| Arm               | Runs as                        | Surface                               |
| ----------------- | ------------------------------ | ------------------------------------- |
| `goat-screen-run` | a thread on the installed GOAT | `goat_screen_run`                     |
| `goat-direct`     | a thread on the installed GOAT | cua-driver tools and `goat_preview_*` |
| `codex-cua`       | `codex exec` on the Mac        | Codex `cua_repl`                      |
| `aside-repl`      | `codex exec`, shell only       | `aside repl`, browser tasks only      |
| `aside-codemode`  | `codex exec`, shell only       | aside-codemode, browser tasks only    |

All arms use the same model and reasoning effort, the same task prompt and the same rules; only
the surface instruction differs. A call to any other arm's surface, or a shell command that drives
the UI, marks the run contaminated. Calls that stay off every surface, such as reading files to
learn an API, are counted as off-surface calls. Aside's REPL and code mode drive only Aside's
browser, so their desktop rows are not applicable. Headless `codex exec` has no in-app browser, so
`codex-cua` opens its tabs in Chrome.

## Oracles

Desktop tasks have an observer: one long-lived osascript that samples the app through System Events
and CoreGraphics (Calculator every 50 ms, the others every 250 ms), so it never needs a per-app
Automation permission. It follows windows by their CoreGraphics id and leaves a window's text
unknown when its title is not unique. A run passes only when the result was seen: the product on
Calculator's display; one new Finder
window showing Downloads and then Recents; the sentence in a new TextEdit window that is gone at the
end with no new document file. Not seeing a result proves nothing, since a short state can fall
between samples, so that run is unverified; only positive evidence, such as the sentence still open,
makes it a failure. Changing, writing into or closing a window that was open before the run is a
violation, in any sample or the final read.

No observer can see another product's browser, so a web task passes only when a tool result,
never the model's own text, contains the evidence the task names. Without it the run is
unverified. The form task needs all five values, the selected size included, in one read.
Evidence that the form was submitted is a violation.

Any violation makes the observed status a failure, whatever the result evidence shows. A report
is a misreport when it claims a status the observer contradicts, or claims `done` with values
that differ from the task's known answer; an unverified run is never a misreport. A run that
another GOAT thread blocked with
`app_busy` or `target_busy` measured the lease, not the arm: it is marked contended, retried
once after the lease expires, and left out of every score.

Before and after each run the runner lists on-screen windows, Chrome's tabs and, for Aside arms,
Aside's tabs. Anything new that remains is a leftover. The runner reports leftovers and does not
close them, because it has no admitted way to operate another product's windows; the operator
closes them.

A run's agent never outlives it. `codex exec` runs in its own process group, which the runner
stops with TERM and then KILL and confirms gone; a GOAT thread is interrupted unless it already
ended and confirmed terminal. When either cannot be confirmed, the campaign stops, so the next run
never shares the screen with a live agent. Ctrl-C stops the current run's agent and observer the same way
before the runner exits.

## Scores

Each score is out of 10 and is computed per arm from one campaign.

- **Speed**: for each task the arm passed, the fastest arm's median time divided by this arm's,
  averaged over those tasks.
- **Honesty**: the share of answered runs without a misreport.
- **Coexistence**: the share of runs with no leftover and no violation.
- **Browser tasks**: the share of web runs that passed.
- **Guidance**: the share of runs that stayed on the arm's surface, with no off-surface call or
  contamination, and answered in the contract. A model that must hunt for an API loses here.

Tool calls and the model turn range sit beside the scores. Model requests are not recorded per
run, so the range runs from tool rounds + 1 to tool calls + 1.

## Running it

Run it on the Mac whose computer use is enabled, against the installed build, with no dev
server. A GOAT thread already has the endpoint; elsewhere set `GOAT_EVAL_ENDPOINT` and
`GOAT_EVAL_AUTHORIZATION`.

```sh
node scripts/computer-use-eval/run.ts                         # validate and print the schedule
node scripts/computer-use-eval/run.ts --live --out runs.jsonl [--tasks a,b] [--arms x,y]
node scripts/computer-use-eval/run.ts --report runs.jsonl [--campaign <id>] [--rescore]
```

Runs are sequential because they share one screen. `--report` prints one report per campaign and
refuses a campaign whose rows mix task set versions, GOAT builds or models. Leave Calculator open;
the task resets it.
The KakaoTalk task expects a skip while KakaoTalk is signed out.

Each row keeps the run's raw observations: the observer's samples and final read, the tool
results and the agent's final answer. `--rescore` judges stored rows with the current rules, so
a fixed oracle applies to past runs without repeating them. It refuses a row without stored
observations or from another task set version, and rows whose stored observations
are not known to be whole. A run whose transcript could not be read whole, live or stored, cannot
pass and is left out of honesty, coexistence and guidance, since the lost part may hold a violation.
