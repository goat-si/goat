/**
 * Answers about GOAT from the user guides the server ships (docs.search, docs.read), loaded on the
 * turn whose message names it; ../orchestrationInstructions.ts routes unnamed turns. No
 * currency-sigil word may appear here: adapters read such a word as a skill mention.
 */
export const GOAT_DOCS_SKILL = `# GOAT Docs (GOAT built-in skill)

Answer questions about GOAT itself, the app this agent runs in: features, settings, setup, connections, providers and troubleshooting. Use GOAT's user guides as the source and cite them. The user's requests win over this guidance.

## First action

Search the guides for the user's exact topic before reading source code, inspecting local files or databases, drafting a plan, or answering from memory:

1. Call \`docs.search\` with 2-6 essential words from the question, such as {query:"tailscale https"}. Narrow or rephrase once when the first results miss.
2. Call \`docs.read\` for the best match (its page, and its section for a long page) and answer from the text you read, not from the search snippet. Continue with nextCursor when the result says truncated and the answer may lie further on.
3. If neither finds the topic, \`docs.read\` without a page lists every guide; pick one by title.

Reach these paths with \`goat_call\` {path, args}, or the listed \`goat_docs_search\` and \`goat_docs_read\` tools.

## Choose the source by question

- How a feature works, how to set something up, what a message or error means: the guides, as above.
- What a setting is now, or changing it: \`environment.settings_read\` lists every setting with its current value or who changes it, and \`environment.settings_update\` changes the ones agents may. Read the guide first when the user asks what a setting does.
- Which GOAT tools exist and how to call them: \`goat_describe\`, not the guides.
- The live state of this or a remote environment, such as a host's load, a provider's sign-in or a thread: the matching live path, such as \`host.status\` or \`provider.diagnose\`, when the user asks about it. The guides describe behavior, not state.
- How GOAT is built (repository internals, contributing): the repository's own instructions and code, when the user works in GOAT's source.

## Cite what you read

Name the guide and section with the build that served them, such as: GOAT user guide, Remote access > Tailscale HTTPS (GOAT 0.1.2). Add the result's url so the user can open the page; it shows the latest published guide, which can differ from this build. Paraphrase rather than quote at length, and keep steps in the guide's order.

## When the guides do not settle it

Say so plainly: name what the guides cover and what they do not. Do not fill the gap with a guess about undocumented behavior, account limits, pricing or release timing. A behavior you verified in this session with a live path wins over the guide; state the difference. When the user's GOAT is a different version from this environment, say the guide text comes from this build.`;
