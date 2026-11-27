# Evaluating an edited memory across threads

Can a conversation that used an old acceptance code issue a ticket with the current code after another thread edits the memory?

Run the offline fixture from the repository root with the project's Node version and dependencies installed:

```sh
node apps/server/scripts/evaluate-memory-handoff.ts
```

The runner creates a new in-memory GOAT database. A thread-scoped memory on A holds a random code. B, a different thread bound to the same shared project, recalls it. The fixture updates that same memory using its old revision as the expected head, then reads it from B twice: immediately before indexing the edit and immediately afterwards. Each read has its own run ID. The JSON row records the ground truth, index coverage, returned revisions and Turn memory receipt revisions. Offline mode makes no model requests.

## Replay with a model

Set a Chat Completions URL for a model you intend to use. A local example:

```sh
GOAT_MEMORY_EVAL_COMPLETIONS_URL=http://127.0.0.1:8080/v1/chat/completions \
  node apps/server/scripts/evaluate-memory-handoff.ts --live --model my-local-model
```

Set `GOAT_MEMORY_EVAL_API_KEY` only if the endpoint needs a bearer token. Live mode sends synthetic text to that endpoint. The first completion must issue a ticket containing the old code. An invalid first ticket produces an unqualified row. Both subsequent completions start from the same qualified conversation history, so the indexed reply cannot learn the new code from the pending reply. Each receives only its own recall results and coverage. A ticket has one field, `acceptanceCode`, containing the verified code or `null`.

Read the evidence and the ticket together:

| Observation                                                    | Interpretation                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Partial coverage, no code supplied, ticket is null             | The agent abstained while the index caught up.                                  |
| Partial coverage, no code supplied, ticket uses the old code   | The conversation retained the old value and reused it without current evidence. |
| Current revision supplied, ticket uses the old code            | The agent ignored the updated value.                                            |
| Current revision supplied, ticket uses the new code            | The ticket is grounded in the current revision.                                 |
| Ticket uses the new code without that revision in the evidence | Report as unsupported, even though the value matches.                           |

This is a controlled model replay. It measures how a model uses supplied recall results. The runner invokes recall at known index boundaries and supplies those results explicitly. It does not measure whether a GOAT provider would autonomously call recall or when a production indexer would finish. Keep unqualified runs, invalid tickets and abstentions visible when comparing models.

## Ask a real GOAT thread

To observe a provider answering an everyday project question, run with an installed, authenticated provider instance and an available model. For example:

```sh
node apps/server/scripts/evaluate-memory-natural.ts --provider codex --model gpt-6-luna
```

This opt-in run makes three live provider turns. It starts a temporary local GOAT with an empty project and a new memory database. A reader asks “How do I install this project's dependencies?” before and after a user in a second thread changes the package manager from npm to pnpm. Both reader turns use the same prompt. The fixture persists the edit against the original head with the writer's message as evidence, so the measurement focuses on what the reader receives and answers. It does not force a recall call, supply recall results, or wait for indexing. In supervised mode the fixture can confirm an identifiable GOAT recall call once. Other tool approvals end the run with an error.

The JSON includes both answers, the expected revision on each turn, revisions delivered automatically (`automatic`), revisions returned by active recall (`recalled`), recall tool calls and receipt event counts. These observations are scoped to the reader's exact run and the fixture memory. A correct answer with the current revision in either channel is `grounded-current`, including a turn with zero lookups. A correct answer with no recorded current revision is `unsupported-current` or, if evidence is incomplete, `evidence-incomplete`. A follow-up that still says npm is `stale`. The raw answer is retained even when it is not a single install command. Only compare qualified rows when asking how an agent that demonstrably had the original revision responds to the edit.
