# CI

goat-si/goat keeps two core workflows active: `.github/workflows/goat-ci.yml` runs CI, and `goat-nightly.yml` publishes
nightlies after a manual goat-ci run on `dev` and promotes soaked nightlies to stable
([stable promotion](../docs/internals/release-channels.md#stable-promotion)). Every upstream workflow is disabled on GitHub. The pre-push hook
`.vite-hooks/goat-workflow-guard.mjs` refuses a push that carries any other enabled workflow, and
holds `goat-ci.yml` to the jobs `scope`, `ci`, `screenshot-gate`, `result`, `republish`,
`refresh-republished` and `connect-auth-postgres`, the pinned
`ubuntu-24.04` image (or, for the `ci` matrix, `windows-2025` and the trusted-run lidge
matrix expression, and for the gate jobs the trusted-run lidge gate expression), the `push`, `pull_request`, and
`workflow_dispatch` triggers, and an allowlist of actions.
A new check is therefore a matrix task of `ci`. Any other new workflow, a
`pull_request_target` trigger, or `actions/github-script` does not pass the guard.

The heavy matrix tasks of a trusted run (a manual run or a same-repository pull request) run on the
lidge pool: one Ryzen 9950X3D box on Ubuntu 26.04 whose scaler creates an ephemeral JIT runner
(labels `self-hosted`, `linux`, `x64`, `lidge`) only for trusted runs. Each runner's HOME is
`/opt/actions-runner/$RUNNER_NAME/_home`, which the Toolchain step asserts. The repository variable
`LIDGE_RUNNERS=on` enables the pool; `off` or unset sends those tasks back to `ubuntu-24.04`.
Everything else runs on GitHub-hosted runners: `ubuntu-24.04`, and `windows-2025` for the
`test-windows` entry. The EPYC self-hosted pool was retired in November 2026. Hosted runners are
discarded after each job, so steps may install packages through sudo; the self-hosted steps branch on
`RUNNER_ENVIRONMENT` and expect the box to carry those packages. The free plan caps hosted
concurrency at about 20 jobs, so a few full runs at once queue.

Each `ci` matrix entry carries a `runner` pool from `.github/scripts/goat-ci-scope.cjs`: `windows`
for `test-windows`, `hosted` for the short Node-only tasks in `HOSTED_TASKS` (`check`, `typecheck`
and the small package suites), and `linux` for the heavy tasks (`test`, `test-packages`,
`test-changed`, `test-ssh`, `test-desktop`, `test-memory-growth`, `build` and the server shards).
`hosted` entries always take `ubuntu-24.04`, so short tasks never queue behind the pool, and
`linux` entries take the lidge pool when it is enabled. The gate jobs `goat-scope`,
`goat-screenshot-gate` and `goat-ci-result` take the pool on the same terms (kill switch and
trust test, `ubuntu-24.04` otherwise), because a starved hosted queue left `goat-scope` waiting
for minutes and no lidge task could start before it. They need only Node and git. `republish`
waits on the real run and `refresh-republished` writes to Actions, so both stay on `ubuntu-24.04`
with `connect-auth-postgres`, and the guard pins every `runs-on` value.

goat-ci skips pull requests from forks for now, so a fork's pull request gets no `goat-ci-result`.
To check one, a maintainer pushes its head to a branch in goat-si/goat and runs goat-ci there.

## When goat-ci runs

goat-ci runs on pull requests and by hand. It does not run on push, so merging into `dev` starts
nothing. On a pull request the `goat-scope` job diffs the merge commit against its base, and
`.github/scripts/goat-ci-scope.cjs` picks the matrix. A pull request, draft or ready, gets a quick
run: `check`, `typecheck`, and `test-changed`. The shared selector
(`scripts/lib/changed-tests.ts`) picks changed tests, companion tests, and tests that import a
changed source directly or through testkit/fixture files, so `vp run check:changed` and the PR
run pick the same files. Production importer chains remain in broader lanes. Existing special
suites also run: shared prompt text adds replay suites, and a changed or deleted non-test
`.ts`/`.tsx` file under an app's `src` adds that app's `reactCompilerCoverage` suite when it has
one (web and mobile do).
The server suite runs one file at a time, so its selected tests stay in `test-changed` only while
they fit one six-minute shard. More run as `test-server related` shards, one to four, or as the
full suite when they carry half of its estimated time: one job of 248 server files hit the
60-minute job limit (#1928).
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
changes reach, `ci:server` adds the full server suite, `ci:memory` the memory growth suite, and
`ci:windows` the Windows tests.

`test-windows` runs the path and process sensitive suites (`WINDOWS_SUITES` in
`goat-ci-scope.cjs`) on hosted `windows-2025`, the only CI that sees Windows-only failures
(#1385). It runs in `lane=all`, in the `windows` lane, with `ci:windows`, and on a pull request
that changes a file under one of those suites. Its job stops at 30 minutes.
`test-pen` runs Pen's suites on hosted `ubuntu-24.04` ([pen.md](pen.md#checks)): in `lane=all` and on a pull
request that changes `apps/pen/`, `packages/pen-protocol/`, `infra/pen-relay/` or `infra/pen-login/`
(`PEN_PATHS`), whose suites it owns, so `test-packages` and `test-changed` leave them out. The Go module has no
`package.json`, so paths select it instead of the workspace graph, and the guard allows no `setup-go` action: the
image's `go` switches to the toolchain `apps/pen/go.mod` names.
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
original suite, so a re-run attempt ends with `refresh-republished` (#1691). When the newest later
run on the head is an ignored-event run of the same pull request, the job re-runs it, cancelling it
first while it still runs, so its republish repeats the re-run's verdict. It is the only goat-ci job
with `actions: write` (pinned by `.vite-hooks/goat-workflow-guard.mjs`) and reports no verdict
itself. If the Actions API refuses the cancel or re-run, its `goat-ci republish refresh` check
fails, which is not a required check: re-run that ignored run by hand. `goat-ci-result`
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
