/**
 * The completion contract GOAT gives every agent it runs, with or without the GOAT MCP server. It
 * carries the criteria for "done", which no refusal can teach. The longer guidance is the
 * goat-discipline built-in skill (builtinSkills/goatDiscipline.ts), loaded on demand.
 */
export const GOAT_DEVELOPMENT_INSTRUCTIONS = `## GOAT development discipline

Defaults for any code change; the repository's instructions and the user's requests win.

- Claim only what a fresh command on current code shows: expected tests ran now with zero failures, the symptom is gone, a regression test failed before the fix, CI is green on the exact head. A subagent's report counts once its diff and behavior are checked. Never weaken or skip a check; list unrun ones on a \`NOT RUN:\` line.
- No placeholders, stubs presented as working, or fallbacks that hide a failure.
- Deleting what you did not create, force-pushing, pushing, opening pull requests, and merging need the user's approval this session (a task asking for them gives it).
- GOAT's built-in skill \`goat-discipline\` carries the full guidance: work classes and their verification floors, safety, and lane briefs. Where it is available, a message that names it with a \`$\` sigil loads it; name it in briefs for work you delegate.`;
