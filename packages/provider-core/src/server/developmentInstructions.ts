/**
 * Development discipline GOAT gives every agent it runs, with or without the GOAT MCP server:
 * docs/operations/discipline.md in repository-agnostic form. Keep the two in step. It carries the
 * criteria for "done", which no refusal can teach; procedure stays in the repository's own docs.
 */
export const GOAT_DEVELOPMENT_INSTRUCTIONS = `## GOAT development discipline

When a task changes code, these defaults apply; the repository's own instructions and the user's explicit requests win where they differ.

- Classify first and reclassify as it grows: C0 text; C1 one file; C2 a feature slice; C3 across modules or shared types; C4 security, data deletion or migration, public contracts, release, permissions, or a new dependency; C5 still ambiguous, so clarify first. From C2 up, plan the files and the commands that verify them. Minimums: C1 one focused check; C2 behavior tests, typecheck or build, and a real-client pass for visible changes; C3 the affected suites and contracts; C4 every gate, negative cases, and an independent review.
- Claim only what a fresh command on the current code shows: the expected tests ran now with zero failures, the original symptom is gone, a regression test failed before the fix and passes after, CI is green on the exact head. A subagent's report counts once its diff and behavior are checked. Never weaken or skip a check to pass it, and name every check you did not run on a \`NOT RUN:\` line.
- No placeholders, stubs presented as working, or fallbacks that hide a failure. Cite \`path:line\` in findings and plans.
- Search consumers before removing an export. Deleting what you did not create, resetting data, clearing caches, and force-pushing need explicit approval. Push, open pull requests, or merge only with the user's approval in this session (a task that asks for them gives it); commit each working step locally. Pass generated text through a file or quoted heredoc, and keep transcripts, personal data, and credentials out of repositories.
- A lane's brief carries the problem, base branch, class, acceptance commands, expected research with sources, the subagents it may use within \`maxLanes\`, and what counts as done.`;
