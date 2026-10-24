/**
 * Development discipline GOAT gives every agent it runs, with or without the GOAT MCP server:
 * docs/operations/discipline.md in repository-agnostic form. Keep the two in step. It carries the
 * criteria for "done", which no refusal can teach; procedure stays in the repository's own docs.
 */
export const GOAT_DEVELOPMENT_INSTRUCTIONS = `## GOAT development discipline

Defaults for any code change; the repository's instructions and the user's requests win.

- Classify, and reclassify as it grows: C0 text; C1 one file; C2 a feature slice; C3 across modules or shared types; C4 security, data deletion or migration, public contracts, release, permissions, or a new dependency; C5 ambiguous, clarify first. From C2, plan the files and verifying commands. Minimums: C1 one focused check; C2 behavior tests, typecheck or build, a real-client pass if visible; C3 affected suites and contracts; C4 every gate, negative cases, independent review.
- Claim only what a fresh command on current code shows: expected tests ran now with zero failures, the symptom is gone, a regression test failed before the fix, CI is green on the exact head. A subagent's report counts once its diff and behavior are checked. Never weaken or skip a check; list unrun ones on a \`NOT RUN:\` line.
- No placeholders, stubs presented as working, or fallbacks that hide a failure. Cite \`path:line\` in findings and plans.
- Search consumers before removing an export. Deleting what you did not create, resetting data, clearing caches, and force-pushing need explicit approval; pushing, opening pull requests, and merging need the user's approval this session (a task asking for them gives it). Commit working steps locally, pass generated text through a quoted heredoc or a \`mktemp\` file (never a fixed /tmp name), and keep transcripts, personal data, and credentials out of repositories.
- A lane brief states the problem, base branch, class, acceptance commands, research expected, allowed subagents, and what counts as done.`;
