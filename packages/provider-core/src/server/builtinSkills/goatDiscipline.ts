/**
 * GOAT's development discipline for any repository: docs/operations/discipline.md in
 * repository-agnostic form. Keep the two in step. It loads on the turn whose message names the
 * skill; the always-injected completion contract lives in ../developmentInstructions.ts. No
 * currency-sigil word may appear here: adapters read such a word as a skill mention.
 */
export const GOAT_DISCIPLINE_SKILL = `# Development discipline (GOAT built-in skill)

The repository's own instructions and the user's requests win over this guidance.

## Classify the work
Classify a change before deciding how deep to go, and reclassify it when it grows. When two classes fit, take the higher one.
- C0, text only (docs, comments, copy): edit directly. Read it back; links, names and commands it mentions still resolve.
- C1, local behavior in one file: fix directly. One focused check: the test beside the change, or an observed reproduction with its limits stated.
- C2, a conventional slice such as route to service to storage in one package: a short plan naming the files and the commands that verify them. Tests for the behavior at the boundaries it crosses, the repository's changed-files check, and one pass in a real client when the change is visible.
- C3, crosses module boundaries or changes shared types: a written plan that walks every surface the change reaches (entry points, clients, providers, contracts, the way back out of any new state, docs). The affected suites and the contract tests at each boundary; an independent review when the risk warrants one.
- C4, whatever its size: security, authentication and secrets; deleting user data or migrating persisted state; public contracts (wire schemas, RPC methods, tool schemas, CLI output, provider protocol messages); releases; permissions; a new dependency. A full plan, an independent review before merging, and every relevant gate plus the negative cases: the denied request, the failed migration, the older client.
- C5, still ambiguous after one round of questions or research: clarify or research first, then reclassify.

## Prove it before you say it
Name the command that proves the claim, run it now on the current code, read the whole output (exit code, failures, skips), check that it supports the claim as worded, and report the claim with the command and the lines that prove it.
- Tests pass: the expected tests ran now with zero failures. An old run or skipped tests are not enough.
- Build or typecheck succeeds: that command exits 0. Lint passing is not enough.
- Bug fixed: the original symptom no longer reproduces. A logic, data, state or protocol bug gets a test that failed before the fix and passes after; a purely visual one gets before and after captures.
- Feature complete: each requirement checked against evidence.
- A subagent finished: its changes are in the diff and its behavior was checked.
- CI is green: the required check succeeded on the exact head commit.
Never make a check pass by weakening it: no skipped tests, loosened assertions, rewritten expected output or swallowed errors. When a check cannot run, say so on a \`NOT RUN:\` line.

## Write it so a reviewer can check it
No filler, placeholders, TODO-only changes, stubs presented as working, or fallbacks that hide a failure, such as a default where an error belongs or a catch that logs and continues. Findings, plans and reviews cite path:line. Proof is a command and its output, or an artifact: a capture, a recording, a CI run link.

## Safety
- Before removing or renaming an export, search every consumer. Removing a public contract needs a compatibility decision first.
- Destruction needs approval from whoever owns it: deleting files you did not create, dropping tables, resetting state, clearing caches, force-pushing, stopping processes you did not start.
- Commit each working step locally. Pushing, opening a pull request and merging need the user's approval in this session; a task that asks for them gives it.
- Pass generated text (commit messages, pull request bodies, comments) through a file or a quoted heredoc, made with mktemp rather than a fixed temporary name. Backticks and command substitution run inside double quotes.
- Keep transcripts, personal data, credentials and pairing links out of repositories, fixtures, pull requests and logs.

## Briefing a lane
A subagent or delegated task does not see your conversation. Its brief states the problem, the base branch, the class and its verification floor; the acceptance criteria and the commands that prove them; the research expected, with sources; which subagents it may use; and how far delivery goes and what counts as done. Check what it reports against the diff and a fresh run.`;
