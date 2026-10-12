# PR screenshot gate

The `goat-screenshot-gate` task in `.github/workflows/goat-ci.yml` runs
`.github/scripts/pr-screenshot-gate.cjs` on every pull request event that starts goat-ci. When the PR
is not a draft, changes a file under `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing`
(tests and Markdown excluded), and its description embeds no image, the gate reports it. A
maintainer can waive it with the `gui-screenshot-waived` label. The contract is in
[structure/ci.md](../../structure/ci.md#pr-screenshot-gate).

goat-ci does not start on description edits or label changes. The script reads the live PR, so
re-run only the `goat-screenshot-gate` job after adding a screenshot or the label:

```sh
gh run rerun <run-id> --job <job-id> -R goat-si/goat
```

## Modes

The repository variable `GOAT_SCREENSHOT_GATE` selects the mode. Unset or unknown values mean
`warn`.

- `warn`: a warning annotation and a job summary; the job stays green.
- `enforce`: the job fails until the PR has a screenshot or a maintainer waiver.
- `off`: the job reports nothing.

## Switching to enforce

1. Create the waiver label so maintainers can apply it:
   `gh label create gui-screenshot-waived -R goat-si/goat --color c5def5 --description "Maintainer waived the PR screenshot requirement"`.
2. Check the open PRs that change UI paths and embed no image. Ask their authors for a screenshot or
   waive the ones that do not change what a user sees.
3. `gh variable set GOAT_SCREENSHOT_GATE --body enforce -R goat-si/goat`.

Return to advisory mode with `gh variable set GOAT_SCREENSHOT_GATE --body warn -R goat-si/goat`.

goat-si/goat is a private repository without branch protection or rulesets, so even in `enforce` mode
a red `goat-screenshot-gate` job blocks nothing by itself; reviewers treat it like any failed
goat-ci job. If required checks become available, add `goat-screenshot-gate` after switching to
`enforce`.

The waiver counts only when the latest application of the label was by a user with the admin or
maintain role. The PR's own workflow file and script run from the PR branch, so a PR that edits
either one needs the same review as any other CI change.
