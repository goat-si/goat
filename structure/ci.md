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
The hour-long memory growth suite follows only memory, persistence, and the server's top-level code,
plus contracts and shared.

The `ci:full` label runs everything after a re-run, and so does a manual run
(`gh workflow run goat-ci.yml --ref <branch>`). `goat-ci-result` is the one check to read: it fails
when goat-scope or any selected task failed or was cancelled. A successful manual run on `dev` is
what starts a nightly ([release channels](../docs/internals/release-channels.md)).

## PR screenshot gate

The `goat-screenshot-gate` task runs `.github/scripts/pr-screenshot-gate.cjs`. A PR that is not a
draft and changes `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing` (tests and
Markdown excluded) must embed an image in its description. Images inside HTML comments or fenced code
do not count, so the untouched `.github/pull_request_template.md` never satisfies the gate. The
`gui-screenshot-waived` label waives the gate only when the user who last applied it has the admin
or maintain role.

The repository variable `GOAT_SCREENSHOT_GATE` selects `warn` (the default: annotation only),
`enforce` (the job fails), or `off`. goat-ci does not run on description edits or label changes,
so the script reads the live PR and a re-run of that one job re-evaluates it. Switching modes is in
[the operations guide](../docs/operations/pr-screenshot-gate.md).

Screenshot evidence never lands on `dev`. Authors drag images into the description editor or
commit them to the orphan `pr-assets` branch and link them by commit SHA.
