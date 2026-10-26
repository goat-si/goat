# CI

goat-si/goat keeps three workflows active: `.github/workflows/goat-ci.yml` runs CI, `goat-nightly.yml` publishes
nightlies after a manual goat-ci run on `dev` and promotes soaked nightlies to stable
([stable promotion](../docs/internals/release-channels.md#stable-promotion)), and `close-outside-prs.yml` closes pull requests from
forks whose authors lack write access. Every upstream workflow is disabled on GitHub. The pre-push hook
`.vite-hooks/goat-workflow-guard.mjs` refuses a push that carries any other enabled workflow, and
holds `goat-ci.yml` to the jobs `scope`, `ci`, `screenshot-gate` and `result`, the pinned
`ubuntu-24.04` image, the EPYC self-hosted labels, or the trusted-run expressions below, the `push`, `pull_request`, and
`workflow_dispatch` triggers, and an allowlist of actions.
A new check is therefore a matrix task of `ci`. Any other new workflow, a
`pull_request_target` trigger outside `close-outside-prs.yml`, or
`actions/github-script` does not pass the guard.

Every goat-ci job picks its runner with a `runs-on` expression. A manual run, or a pull request whose head
branch lives in goat-si/goat, runs on the EPYC self-hosted runners; a pull request from a fork runs
on GitHub-hosted `ubuntu-24.04`, so fork code never reaches EPYC. The free plan caps hosted
concurrency at about 20 jobs, which a few full pull request runs saturate, while EPYC carries two
dozen runners. The trust test lives in that expression, so the guard pins its exact text. EPYC
runners persist between jobs and give jobs no sudo: each keeps its caches in its own HOME, and the
steps that install packages or unlock the runner account for the test sshd run on hosted runners
only.

The `ci` matrix takes runners labelled `epyc`. `goat-scope`, `goat-screenshot-gate` and
`goat-ci-result` take the same expression with the label `epyc-light`, which
`goat-epyc-23` and `goat-epyc-24` carry instead of `epyc`. A matrix job never lands on them, so
these short jobs start within seconds even while every matrix runner is busy; on the shared pool
`goat-ci-result` waited half an hour for one. The guard holds the gate jobs to that expression
or `ubuntu-24.04` and keeps the matrix off it. Custom labels live on GitHub, so a runner
re-registered with its default labels rejoins the matrix pool; restore one with
`gh api -X PUT repos/goat-si/goat/actions/runners/<id>/labels -f 'labels[]=goat' -f 'labels[]=epyc-light'`.

`close-outside-prs.yml` is the one `pull_request_target` workflow. It runs from the repository's default branch (`dev`)
with a write token, so the guard pins it to the `opened` and `reopened` events and to
`pull-requests: write`, and pins its single `close` job by a hash of the reviewed job. A
command blocklist cannot prove that a script never fetches or runs pull request code, so any edit
to that job, including its step names, scripts and env, fails until someone reviews it and
updates the hash in the guard.

## When goat-ci runs

goat-ci runs on pull requests and by hand. It does not run on push, so merging into `dev` starts
nothing. On a pull request the `goat-scope` job diffs the merge commit against its base, and
`.github/scripts/goat-ci-scope.cjs` picks the matrix. A pull request, draft or ready, gets a quick
run: `check`, `typecheck`, and `test-changed`, the test files beside the changed files that
`vp run check:changed` runs before a push (`scripts/lib/changed-tests.ts`, so the two never pick
different files). Suites that find their files another way are added: shared prompt text adds the
replay suites, and a changed or deleted non-test `.ts`/`.tsx` file under an app's `src` adds that
app's `reactCompilerCoverage` suite when it has one (web and mobile do).
Documentation alone runs only `check`, and a change that selects no tests skips `test-changed`. The
full suite runs on request: the `ci:full` label, or a manual run of the branch.
`goat-scope` always runs `node scripts/goat-rename.ts --check` before task selection, so new upstream product names fail `goat-ci-result`.

The `ci:affected` label replaces the quick run with the tasks the changed files reach through the
workspace dependencies in the `package.json` files. A file the script cannot place, any
`package.json`, a workflow, a script, or the lockfile runs everything there. Its two slow suites
follow the static import graph that `.github/scripts/goat-ci-imports.cjs` reads
from the sources (relative imports, package `exports`, `vi.mock`, literal dynamic imports, and
`new URL(…, import.meta.url)`). The server suite runs only the test files that import a changed
file, in one to four shards, plus files that name a changed file in a string (a script a test
spawns, a fixture directory a test loads). It runs in full when those files carry half of the
suite's estimated time, when a change reaches the Vitest config or its setup files, or when a
changed data file is neither imported nor named anywhere. The memory growth suite runs when a
change under `apps/server/src/memory` or `apps/server/src/persistence` reaches it. The `goat-scope`
job summary lists each chosen server test file and the change that reached it.

Labels widen a run as soon as they are added: `ci:full` runs everything, `ci:affected` what the
changes reach, `ci:server` adds the full server suite, and `ci:memory` the memory growth suite.
Retargeting a pull request onto `dev` or `goat/**` starts a run against the new base and supersedes
the old one. Any other label, and any edit that keeps the base, runs no task, but GitHub still
creates a goat-ci suite for it and reads the required `goat-ci-result` from the newest suite on the
head commit (#1672). So its `republish` job reports `goat-ci-result`: on a hosted runner, it waits
for the newest real goat-ci run of the same pull request on the same head and repeats that run's
`goat-ci-result`. Success passes and anything else fails, so a newer real run decides even when it
was cancelled. The run listing can lag behind events, so it decides only once its own run is a
minute old and a second listing names the same run and attempt; a real run listed more than a
minute after a later edit's run, or created out of event order, can still be missed. A wait that
outlives the six-hour hosted job limit fails. Ignored runs take a concurrency group of their own
per pull request, because a group holds one pending run and an ignored newcomer would cancel a real
run waiting there. Skipped jobs
keep their raw name expressions, so no skipped check carries a real name. A re-run keeps its run's
original suite, and a republished result is never refreshed: after re-running a real run that an
edit or label followed, re-run that later run too. Until then a red re-run stays hidden behind a
republished green, and a green one stays blocked behind a republished red (#1691). `goat-ci-result`
is the one check to read: it fails when goat-scope or any selected task failed or was cancelled, and
its notice says whether the run was quick and names the label and the command that start the full
run.

A manual run (`gh workflow run goat-ci.yml --ref <branch> [-f lane=<lane>]`) runs a lane: `all`
(the default, everything), `server` (the full server suite), `memory-growth`, or `quick` (check and
typecheck). Each manual run has a concurrency group of its own, so a merge into `dev` or another
dispatch cannot cancel it. A successful `lane=all` run on `dev` marks its commit green, and the scheduled nightly builds the
newest green commit ([release channels](../docs/internals/release-channels.md)); goat-ci names
manual runs `goat-ci <lane> on <branch>` and the nightly checks that name.

The quick run trades coverage for runner time, so `dev` needs a full run regularly. A
GitHub `schedule` trigger runs from the default branch, `dev`, but the guard does not allow
`schedule` in goat-ci. The daily full run is therefore a manual `lane=all` dispatch on `dev`
(`gh workflow run goat-ci.yml --ref dev`) from a scheduler outside GitHub. Moving it into the
workflow only means allowing `schedule` in the guard.

Pull requests merge when `goat-ci-result` is green on their exact head, without first catching up
with `dev`, so batch merging also runs `lane=all` on `dev` after about every five merges
([merging](../docs/operations/merging.md)).

## PR screenshot gate

The `goat-screenshot-gate` task runs `.github/scripts/pr-screenshot-gate.cjs`. A PR that is not a
draft and changes `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing` (tests and
Markdown excluded) must embed an image in its description. Images inside HTML comments or fenced code
do not count, so the untouched `.github/pull_request_template.md` never satisfies the gate. The
`gui-screenshot-waived` label waives the gate only when the user who last applied it has the admin
or maintain role.

The repository variable `GOAT_SCREENSHOT_GATE` selects `warn` (the default: annotation only),
`enforce` (the job fails), or `off`. A description edit, or a label other than `ci:*` (the waiver
included), runs no goat-ci task, so the script reads the live PR and a re-run of that one job
re-evaluates it, followed by a re-run of the goat-ci run the edit or label started. Switching modes is in
[the operations guide](../docs/operations/pr-screenshot-gate.md).

An embed counts only if it loads for a reader. A relative path resolves against the PR page, and a
branch name moves, so both fail along with a `/blob/` viewer page. Any other URL must answer an
anonymous request with HTTP 200 and an image content type. One broken embed fails the gate. When an
image cannot be fetched because of a network error, timeout, or 5xx, the result is inconclusive
instead.

Screenshot evidence never lands on `dev`. Authors drag images into the description editor or
upload them with `scripts/pr-assets.ts`, which commits to the orphan `pr-assets` branch and links
them by commit SHA.
