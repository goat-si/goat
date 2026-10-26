# Measuring GOAT's context budget

GOAT puts the same three things into every agent's context: a tool listing from `/mcp`, an
instruction block, and the wake messages it writes into a thread. This page explains how to
measure them per harness, so a change to the agent surface can show what it saved.
[context-budget.ts](../../scripts/agent-surface/context-budget.ts) does the measuring:

```sh
node scripts/agent-surface/context-budget.ts            # table
node scripts/agent-surface/context-budget.ts --json     # raw numbers
node scripts/agent-surface/context-budget.ts --db <copy of statev2.sqlite>
```

The script builds the tool catalog in-process from the registrations `/mcp` mounts, with inert
services, so it measures the checked-out commit without starting a server. Instruction text comes
from the exported builders, and the script composes each harness's text the way its adapter does.
Each harness also names a fragment its adapter must still contain. When an adapter changes how it
composes the block, the script exits 1 with the fragment it could not find. Update the
composition then; a guess would report a stale number.

The script also lists the catalog as an outside MCP client that sends `x-goat-tool-listing: core`
and reports that listing beside the harnesses. `--check` holds it to the same listing budget.

`--db` adds the wake messages the server wrote into threads (monitor and background-task reports,
delegated completions), grouped by kind. Copy the database and its `-wal` file first and pass the
copy. The script opens it read-only. Wake sizes depend on what a machine has run, so record the
sample size with the numbers.

## Reading the numbers

Tokens are UTF-8 bytes divided by four, the estimate Codex itself uses for additional context.
Real tokenizers differ by model, so compare runs of this script with each other, not with
provider bills.

- **Listing** counts what a harness hands the model per tool: name, description, input schema,
  and annotations. Output schemas travel in `tools/list` too and are reported separately, since
  harnesses differ in whether the model sees them.
- **Instructions** is GOAT's block for one default-mode turn with GOAT MCP and browser tools
  attached, and device tools, computer use, and memory content left out.
- **First prompt** is instructions plus the full listing. Claude Code, Codex, and Pi have a native
  tool search and may defer MCP tools when the listing is large, so for them the listing part is
  an upper bound. GOAT still serves every byte of it.
- **Each later turn** is what GOAT appends to every later user turn. Codex, Claude, OpenCode, and
  Pi keep the block resident and resend it only when it changes or after compaction, so they add
  nothing per turn, though a resident block is reread on every model request. Cursor and ACP
  append the runtime block to every message, so their cost grows with the conversation.

## Baseline

Measured on `dev` at `368b2c84a` on 2026-10-23, before the context diet.

The served listing has 202 tools and 278,143 B (about 69,500 tokens) of model-facing text:
105,620 B of descriptions and 146,923 B of input schemas. Output schemas add 497,515 B to the
790,809 B `tools/list` payload. The largest tools are `goat_thread_launch` (12,721 B),
`goat_ssh_thread_launch` (11,343 B), and `goat_task_create` (9,218 B).

| Harness           | Instructions | First prompt | Each later turn |
| ----------------- | -----------: | -----------: | --------------: |
| Codex (code mode) |     25,226 B |    303,369 B |             0 B |
| Claude            |     22,208 B |    300,351 B |             0 B |
| OpenCode          |     22,224 B |    300,367 B |             0 B |
| Cursor            |     22,328 B |    300,471 B |         2,150 B |
| ACP               |     24,519 B |    302,662 B |         2,040 B |
| Pi                |     20,072 B |    298,215 B |             0 B |

Codex is largest because its block also carries GOAT's collaboration-mode text and the browser
section. On one Linux host with a small history, wakes were 209 B for each of six monitor reports,
560 B for one delegated completion, and 2,155 B for one background-task report.

## Search contract

[search-contract.ts](../../scripts/agent-surface/search-contract.ts) checks the other half of a
search core: whether an agent can find what it needs.

```sh
node scripts/agent-surface/search-contract.ts [--json]
```

For five daily tasks (launch a remote thread, read its result, answer a pending question, watch a
pull request, check host pressure), it runs fixed `goat_describe` queries as a GOAT thread would
and reports where the task's path ranks. A task passes when one query ranks it in the top five and
`goat_call` reaches the path's argument checks or handler. The script also reruns every query
resource by resource and fails when a search that returned fewer paths than match says it was not
truncated, or returns nothing while a resource matches. That is the silent loss in
[aside-codemode issue #41](https://github.com/lidge-jun/aside-codemode/issues/41), checked with the
server's own search so the script keeps no index of its own. Add new phrasings rather than editing
old ones; an edited query measures something else.

At `368b2c84a`, every task passes and no search hides loss. Natural phrasings still miss, because
every word must appear in the entry: "reply to pending request", "babysit pr checks", "pr merge
watch", and "which host has room" return nothing, and "check host load" and "watch PR" return
results without the right path.
