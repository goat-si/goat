# Code budgets

These budgets keep files reviewable and keep GOAT's upstream merges cheap. The
`goat/code-budget` lint rule enforces the first two. It runs in `vp run check:changed` and in
the `check` task of goat-ci, and it reads its baseline from
[code-budgets.json](../../oxlint-plugin-goat/code-budgets.json).

## File size

A new file stays under about 800 lines. Past that point, split it along a responsibility
boundary, such as one service per file or protocol parsing apart from the session lifecycle. When
a file cannot split cleanly, say why in the pull request.

The hard limits:

- No file may exceed 1000 lines unless the baseline lists it.
- A listed file may not grow past its recorded length. Put new code in a new module and call it
  from the old one.

Tests count too. Generated files (`_generated/`, `*.gen.ts`, `*.generated.ts`, `*.graphql.ts`)
are exempt because they grow with their schema. The rule covers JavaScript and TypeScript files;
script blocks in `.astro` and `.vue` files are outside it.

On 2026-10-23 the baseline listed 325 files over 1000 lines, 182 of them outside tests. The table
is that day's list of production files over 3000 lines, the first to split; the baseline stays
the current record. The upstream column is the file's length at the upstream merge base, so the
difference is roughly what GOAT added.

| File                                                           | Lines | Upstream |
| -------------------------------------------------------------- | ----: | -------: |
| `apps/server/src/orchestration-v2/Orchestrator.ts`             | 14228 |    11573 |
| `apps/server/src/memory/MemoryStore.ts`                        | 12377 |     GOAT |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | 10957 |     9269 |
| `packages/provider-acp/src/server/adapter.ts`                  |  8663 |     8084 |
| `packages/ssh/src/tunnel.ts`                                   |  8616 |     1774 |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`  |  8602 |     7369 |
| `apps/server/src/orchestration-v2/ProjectionStore.ts`          |  8072 |     6653 |
| `apps/server/src/vcs/GitVcsDriverCore.ts`                      |  5160 |     4108 |
| `scripts/build-desktop-artifact.ts`                            |  4951 |     4169 |
| `apps/web/src/composerDraftStore.ts`                           |  4491 |     4613 |
| `packages/provider-opencode/src/server/v2/adapter.ts`          |  4332 |     4496 |
| `apps/web/src/components/ChatView.tsx`                         |  4308 |    12177 |
| `apps/server/src/mcp/OrchestratorMcpService.ts`                |  4252 |     2669 |
| `packages/contracts/src/orchestrationV2.ts`                    |  4133 |     3829 |
| `apps/web/src/components/chat/ChatComposer.tsx`                |  4062 |     7755 |
| `apps/web/src/components/LegacySidebar.tsx`                    |  4003 |     3915 |
| `packages/provider-opencode/src/server/adapter.ts`             |  3885 |     3778 |
| `apps/server/src/ws.ts`                                        |  3854 |     3269 |
| `apps/desktop/src/preview/Manager.ts`                          |  3779 |     3828 |
| `apps/server/src/pullRequest/PullRequestService.ts`            |  3606 |     3547 |
| `apps/web/src/components/Sidebar.tsx`                          |  3545 |     5660 |
| `packages/contracts/src/agentSurface/registry.ts`              |  3494 |     GOAT |
| `packages/provider-pi/src/server/adapter.ts`                   |  3429 |     3475 |
| `apps/server/src/terminal/Manager.ts`                          |  3383 |     3216 |
| `apps/server/src/git/GitManager.ts`                            |  3301 |     3076 |
| `apps/mobile/src/features/threads/ThreadFeed.tsx`              |  3214 |     3377 |
| `packages/contracts/src/memory.ts`                             |  3128 |     GOAT |
| `apps/server/src/channels/ChannelRemoteWorkers.ts`             |  3122 |     GOAT |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts`   |  3116 |     2470 |
| `packages/contracts/src/rpc.ts`                                |  3032 |     2072 |

The baseline holds the full, current list. When you split a file in an upstream-owned module,
move GOAT's additions out first. Reorganizing upstream's own code creates the conflicts the next
section avoids.

## Non-null assertions and casts to `any`

New code outside tests does not use non-null assertions (`value!`). Narrow the type with a check,
`Option`, or a schema decode, so the failure has a name and a message. Tests may use `!`: a
failed lookup there fails the test, which is the intended result.

No new code, tests included, casts to `any`. Use the precise type, `unknown` with a decode, or a
typed fake.

Files that already contain either are listed in the baseline with their count, which may not rise.
On 2026-10-23 that was 1974 non-null assertions in 543 production files, and 16 casts to `any`.

## GOAT code in GOAT modules

GOAT is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) and merges upstream every
cycle ([chase rules](../../devlog/_chase/README.md)). Every line GOAT changes in an upstream file is
a line that can conflict on the next merge. A measurement on 2026-10-23 found 3,707 upstream files
modified by GOAT.

- Put a GOAT feature in a GOAT-owned module: a new file or directory that upstream does not have.
- Change an upstream file only with a thin hook: an import, a registration, a call into the GOAT
  module, or a field the contract needs. Keep logic out of the hook.
- When a GOAT feature must change upstream behavior, record the area and its merge policy in
  [the fork delta registry](../../devlog/_chase/010_fork_delta.md).
- To check whether a file is upstream-owned, run
  `git cat-file -e "$(git merge-base origin/dev upstream/main)":<path>`. Exit status 0 means it is.

## Updating the baseline

When a change shrinks a listed file or removes assertions, lower its entry so the slack cannot be
spent again:

```sh
node oxlint-plugin-goat/update-code-budgets.ts
```

The script lowers entries to what the files hold now and drops files that no longer need one. It
never raises an entry or adds a file. A file over budget is printed and the script exits 1. Shrink
that file instead of editing the baseline by hand.

An upstream merge can grow upstream files past their entries. The merge commit then rewrites the
baseline with `--init`, and its reviewer checks that every raised entry comes from upstream's
lines, not GOAT's.
