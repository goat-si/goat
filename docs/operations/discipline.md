# Development discipline

This page says how much process a change needs and what counts as proof that it works.
[AGENTS.md](../../AGENTS.md#development-discipline) carries the short form. The
[testing policy](testing.md) says what a test must prove, [code budgets](code-quality.md) limit
file growth, and [merging](merging.md) says when a pull request lands.

## Classify the work

Classify a change before deciding how deep to go, and reclassify it when it grows. When two
classes fit, take the higher one.

| Class | Looks like                                                                        | Process                                                                                                                                  | Verification floor                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0    | Text only: docs, comments, copy. No behavior changes.                             | Edit directly.                                                                                                                           | Read it back. Links, names, and commands it mentions still resolve.                                                                                            |
| C1    | Local behavior in one file, no new abstraction.                                   | Fix directly.                                                                                                                            | One focused check: the test beside the change, or an observed reproduction with its limits stated.                                                             |
| C2    | A conventional slice, such as route to service to storage in one package.         | A short plan naming the files and the commands that verify them. Follow sibling conventions.                                             | Integration or contract tests for the behavior at the boundaries it crosses, `vp run check:changed`, and one pass in a real client when the change is visible. |
| C3    | Crosses module boundaries, changes shared types, or alters what many callers see. | A written plan that walks [Hit every surface](../../AGENTS.md#hit-every-surface). An independent review lane when the risk warrants one. | The affected suites, the contract tests at each boundary, and the docs that describe the behavior.                                                             |
| C4    | See the escalation list below.                                                    | A full plan, an independent review before merging, and explicit approval for anything destructive.                                       | Every relevant gate plus the negative cases (the denied request, the failed migration, the older client), with the evidence in the pull request.               |
| C5    | Still ambiguous after one round of questions or research.                         | Clarify or research first.                                                                                                               | Reclassify as C0 to C4 before building.                                                                                                                        |

These promote the part of a change they touch to C4, however small it looks:

- security, authentication, pairing, tokens, and secrets
- deleting user data, migrating persisted state such as `statev2.sqlite`, and state resets
- public contracts: wire schemas in `packages/contracts`, RPC methods, MCP tool schemas, CLI
  output, and provider protocol messages
- releases and [release channels](../internals/release-channels.md)
- permissions: permission profiles, goatclaw role profiles, and `CLIENT_GUARDED_RPC_SCOPES`
- a new dependency or framework

Split the C4 part into its own commit, and into its own pull request only when a maintainer asks. A class grants
no authority: destructive and outward actions still need the approval described under
[Safety](#safety).

## Prove it before you say it

A completion claim is a claim about the system, so it needs fresh evidence.

1. Name the command that proves the claim.
2. Run it now, on the current code. A result you remember from earlier or a run on another head does
   not count. A task cache that the command validates against the current files, such as
   `vp run typecheck`, is fine.
3. Read the whole output: the exit code and the count of failures and skips.
4. Check that the output supports the claim as you are about to state it.
5. Report the claim with the command and the lines that prove it.

| Claim                       | Requires                                                    | Not enough                                  |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| Tests pass                  | The expected tests ran now, with zero failures              | An old run, skipped or cancelled tests      |
| Build or typecheck succeeds | That command exits 0                                        | Lint passing                                |
| Bug fixed                   | The original symptom no longer reproduces                   | The edit alone                              |
| Feature complete            | Each requirement checked against evidence                   | Tests alone                                 |
| A subagent or lane finished | Its changes in the git diff, and its behavior checked       | The child's report                          |
| Regression test works       | It failed before the fix and passes after (red, then green) | One passing run                             |
| CI is green                 | `goat-ci-result` is `SUCCESS` on the exact head commit      | A queued or cancelled run, or an older head |

Never make a check pass by weakening it: no skipped tests, loosened assertions, rewritten expected
output, or swallowed errors. When a check cannot run, say so on a `NOT RUN:` line instead of
implying it passed. The floors in the class table are minimums. The bug-fix proof rules and the
ban on repository-wide checks in [Verifying](../../AGENTS.md#verifying) still apply: a visual bug
is proven with captures, and CI owns the full suite.

## Write it so a reviewer can check it

- No filler, placeholders, TODO-only changes, stubs presented as working behavior, or fallbacks
  that hide a failure, such as a default where an error belongs or a catch that logs and
  continues. A fallback needs a stated reason at a real boundary.
- Findings, plans, and reviews cite `path:line`. A plan names the files it changes and the
  commands that will verify them.
- Proof is a command and its output, or an artifact: a capture, a recording, a CI run link.

## Safety

- Before removing or renaming an export, search every consumer in `apps/` and `packages/`,
  mobile and desktop included. Removing a public contract needs a compatibility decision first.
- Destruction needs explicit approval from whoever owns what you would destroy: deleting files you
  did not create, dropping tables, resetting state, clearing caches, force-pushing, or stopping
  processes you did not start. The [three ways to hurt yourself](../../AGENTS.md#the-three-ways-to-hurt-yourself)
  still apply.
- Commit each complete, working step locally, with a message that says what it does. Do not let a
  feature pile up uncommitted. Pushing, creating remote branches or tags, opening a pull request,
  and merging need the user's explicit approval in the current session (a task that asks for them
  gives it) and must fit your role; a local commit needs neither.
- Pass generated text (commit messages, pull request bodies, comments, file contents) through a
  file, a quoted heredoc (`<<'EOF'`), or `--body-file`. Backticks and `$()` execute inside
  double-quoted shell strings.
- Keep private material out of the repository, fixtures, pull requests, and logs: user
  transcripts, personal data, credentials, pairing URLs, and `GOAT_DEV_AUTH_TOKEN`. Fixtures use
  invented data. Before the first push of a branch, search its commits for names and numbers that
  identify a person or a customer, and rewrite unpushed commits that contain them.

## Briefing a lane

A subagent, delegated task, or launched thread may not see your conversation, so its brief carries:

- the problem, the base branch, and the class with its verification floor;
- acceptance criteria and the commands that prove them;
- the research expected: current practice from a research tool such as Aside when one is
  available, otherwise web search, with sources cited;
- which native subagents it may use (gpt-6.1-sol, for example), counted against the same
  `maxLanes` limit as dispatched lanes;
- delivery and the finish line, as far as the task authorizes: one request per pull request to
  `dev`, merged under [merging](merging.md) only by a lane that holds merge authority, and done
  when the pull request has merged or `goat-ci-result` is green on its exact head. A codexclaw
  loop records that with
  `cxc loop pr-record --session <id> --pr <url>`. A lane without push approval stops at a local
  commit and reports; a read-only lane, or one sharing your checkout, reports without committing.

Check what a lane reports against the diff and a fresh run, as the claim table says.
