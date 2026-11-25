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
