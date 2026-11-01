# PR screenshot gate

The `goat-screenshot-gate` task in `.github/workflows/goat-ci.yml` runs
`.github/scripts/pr-screenshot-gate.cjs` on every pull request event that starts goat-ci. When the PR
is not a draft, changes a file under `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing`
(tests and Markdown excluded), and its description embeds no image that loads, the gate reports
it. A maintainer can waive it with the `gui-screenshot-waived` label. The contract is in
[structure/ci.md](../../structure/ci.md#pr-screenshot-gate).

## Uploading screenshots

```sh
node scripts/pr-assets.ts upload <pr> before-light.png after-light.png --patch-body
```

The helper commits the files to the orphan `pr-assets` branch as `<pr>/<name>` through a throwaway
index, so the current branch and worktree stay as they are. It fast-forwards the branch and
rebuilds on the new tip when another upload pushes first. It waits until each
`https://raw.githubusercontent.com/goat-si/goat/<commit-sha>/<pr>/<name>` URL serves the image,
then prints the markdown. `--patch-body` rewrites description embeds that point at the same file
through a relative path, a branch name, or a blob page. It changes only those URLs, saves the old
and new body under `--backup-dir` (a temp folder by default), and confirms GitHub stored the new
body. `fix-body <pr>` does the same for files already on `pr-assets`; add `--dry-run` to preview.

GitHub web loads these URLs directly into `<img src>`, and the mobile app fetches the same URL, so
an image that loads for an anonymous request renders on both. GitHub CLI 2.99.0 and later can
upload to GitHub user-attachments instead with `gh pr edit <pr> --attach <file>`, which also
rewrites a body reference to that local path. Those URLs pass the gate as well. The helper keeps
`pr-assets` because it works with any `gh` version and keeps the files in this repository.

## What counts

The gate checks the images in GitHub's own rendering of the description (the API's `body_html`), so
examples in code or HTML comments never count.

- A relative path such as `pr-assets/after.png` fails; GitHub resolves it against the PR page.
- A link to repository contents by branch name fails, such as
  `raw.githubusercontent.com/goat-si/goat/pr-assets/...` or `github.com/.../blob/pr-assets/...`.
  So does a `/blob/` page without `?raw=true`, which serves the file viewer.
- Any other URL must answer HEAD or GET with HTTP 200 and an `image/*` content type within five
  seconds. A 4xx or a non-image response fails.

One failing embed fails the gate, and the summary names each one with its reason. Network errors,
timeouts, and 408, 429, or 5xx responses get three attempts. If an image still cannot be fetched,
the result is `inconclusive` (see below), not a failure.

A description edit, or a label other than `ci:*` (the waiver included), runs no goat-ci task: its
goat-ci run only repeats the earlier `goat-ci-result`. The script reads the live PR, so after
adding a screenshot or the label, re-run the `goat-screenshot-gate` job of the run that tested the
head, then re-run the newer goat-ci run the edit or label started so `goat-ci-result` takes the new
verdict:

```sh
gh run rerun <run-id> --job <job-id> -R goat-si/goat
gh run rerun <newer-run-id> -R goat-si/goat
```

## Modes

The repository variable `GOAT_SCREENSHOT_GATE` selects the mode. Unset or unknown values mean
`warn`.

- `warn`: a warning annotation and a job summary; the job stays green.
- `enforce`: the job fails until the PR has a screenshot or a maintainer waiver.
- `off`: the job reports nothing.

PR metadata, changed-file, and waiver-provenance requests make up to three attempts on network
errors or HTTP 5xx responses, with 250ms/500ms backoff. Other HTTP errors and malformed JSON are
not retried. If inspection or waiver verification fails, the annotation and summary say
`inconclusive`. The script also attempts to add a neutral `goat-screenshot-gate: inconclusive`
check to the PR head, with the failure reason and instructions to re-run the job. This makes an
incomplete inspection visible in the PR checks list. If creating that check fails, such as with a
read-only fork PR token, a warning is logged and the annotation and summary remain available.
The job stays green in `warn` mode and fails in `enforce` mode.
Repeated inconclusive runs reuse the existing check on the same head SHA, and a later conclusive inspection marks it resolved; lookup or update failures only log a warning and do not change the job's exit code.

## Switching to enforce

1. Create the waiver label so maintainers can apply it:
   `gh label create gui-screenshot-waived -R goat-si/goat --color c5def5 --description "Maintainer waived the PR screenshot requirement"`.
2. Check the open PRs that change UI paths and embed no image. Ask their authors for a screenshot or
   waive the ones that do not change what a user sees.
3. `gh variable set GOAT_SCREENSHOT_GATE --body enforce -R goat-si/goat`.

Return to advisory mode with `gh variable set GOAT_SCREENSHOT_GATE --body warn -R goat-si/goat`.

goat-si/goat has no branch protection or rulesets, so even in `enforce` mode
a red `goat-screenshot-gate` job blocks nothing by itself; reviewers treat it like any failed
goat-ci job. If required checks become available, add `goat-screenshot-gate` after switching to
`enforce`.

The waiver counts only when the latest application of the label was by a user with the admin or
maintain role. The PR's own workflow file and script run from the PR branch, so a PR that edits
either one needs the same review as any other CI change.
