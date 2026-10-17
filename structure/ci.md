# CI

goat-si/goat runs one active workflow, `.github/workflows/goat-ci.yml`, on the EPYC self-hosted
runners. Every upstream workflow is disabled on GitHub. The pre-push hook
`.vite-hooks/goat-workflow-guard.mjs` refuses a push that carries any other enabled workflow, and
holds `goat-ci.yml` to the jobs `scope`, `ci`, `screenshot-gate` and `result`, the EPYC runner
labels, the `push`, `pull_request`, and `workflow_dispatch` triggers, and an allowlist of actions.
A new check is therefore a matrix task of `ci`. A separate workflow, `pull_request_target`, or
`actions/github-script` does not pass the guard.

## When goat-ci runs

goat-ci runs on pull requests and by hand. It does not run on push, so merging into `dev` starts
nothing. On a pull request the `goat-scope` job diffs the merge commit against its base, and
`.github/scripts/goat-ci-scope.cjs` picks the matrix tasks the changed files reach through the
workspace dependencies in the `package.json` files. Documentation alone runs only `check`. A file
the script cannot place, any `package.json`, a workflow, a script, or the lockfile runs everything.

The two slow suites follow the static import graph that `.github/scripts/goat-ci-imports.cjs` reads
from the sources (relative imports, package `exports`, `vi.mock`, literal dynamic imports, and
`new URL(…, import.meta.url)`). The server suite runs only the test files that import a changed
file, in one to four shards, plus files that name a changed file in a string (a script a test
spawns, a fixture directory a test loads). It runs in full when those files carry half of the
suite's estimated time, when a change reaches the Vitest config or its setup files, or when a
changed data file is neither imported nor named anywhere. The memory growth suite runs when a
change under `apps/server/src/memory` or `apps/server/src/persistence` reaches it. The `goat-scope`
job summary lists each chosen server test file and the change that reached it.

A draft runs `check` and `typecheck`; marking it ready runs its full scope. Labels widen a run as
soon as they are added: `ci:full` runs everything, `ci:server` the full server suite, and
`ci:memory` the memory growth suite. Any other label starts a run whose jobs all skip under the name
`goat-ci (label ignored)`, so it neither cancels the real run nor puts a skipped check with a real
name on the commit. `goat-ci-result` is the one check to read: it fails when goat-scope or any
selected task failed or was cancelled.

A manual run (`gh workflow run goat-ci.yml --ref <branch> [-f lane=<lane>]`) runs a lane: `all`
(the default, everything), `server` (the full server suite), `memory-growth`, or `quick` (check and
typecheck). Each manual run has a concurrency group of its own, so a merge into `dev` or another
dispatch cannot cancel it. A successful `lane=all` run on `dev` is what starts a nightly
([release channels](../docs/internals/release-channels.md)); goat-ci names manual runs
`goat-ci <lane> on <branch>` and the nightly checks that name.

Path selection trades a little coverage for runner time, so `dev` needs a full run regularly. A
GitHub `schedule` trigger would run only from the default branch, `main`, whose goat-ci is an older
copy, and the guard does not allow `schedule`. The daily full run is therefore a manual
`lane=all` dispatch on `dev` (`gh workflow run goat-ci.yml --ref dev`) from a scheduler outside
GitHub. Moving it into the workflow means promoting `goat-ci.yml` to `main` and allowing `schedule`
in the guard.

## PR screenshot gate

The `goat-screenshot-gate` task runs `.github/scripts/pr-screenshot-gate.cjs`. A PR that is not a
draft and changes `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing` (tests and
Markdown excluded) must embed an image in its description. Images inside HTML comments or fenced code
do not count, so the untouched `.github/pull_request_template.md` never satisfies the gate. The
`gui-screenshot-waived` label waives the gate only when the user who last applied it has the admin
or maintain role.

The repository variable `GOAT_SCREENSHOT_GATE` selects `warn` (the default: annotation only),
`enforce` (the job fails), or `off`. goat-ci does not run on description edits, and a label other
than `ci:*` (the waiver included) starts no job, so the script reads the live PR and a re-run of
that one job re-evaluates it. Switching modes is in
[the operations guide](../docs/operations/pr-screenshot-gate.md).

Screenshot evidence never lands on `dev`. Authors drag images into the description editor or
commit them to the orphan `pr-assets` branch and link them by commit SHA.
