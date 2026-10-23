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
