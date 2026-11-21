# 130 — Linear (G19)

**Class:** C4 (external account, credentials). **Severity:** P2. **Decision:** D5 (NEEDS_HUMAN). **Depends on:** 010.

## Problem

Orca routes Linear issues to a default bot (`274_orca/src/main/runtime/rpc/methods/bots-linear.ts:11`). GOAT has none.

## Decision D5

Deferred until the owner chooses what the integration may read and write: workspace and teams, which issue actors may start work, polling vs webhook (a webhook needs a public URL until GOAT Connect), and whether comment write-back is allowed. Agents never create the Linear account or key; a persistent key needs an owner-authorized consumer, since `handoff.create` returns a one-use reference (`packages/contracts/src/agentSurface/entries/handoff.ts:4`).

## Shape once D5 is answered

Issues matching the chosen team/label become 010 `work` events for the bound bot with a durable cursor and per-issue dedupe; unlink stops polling and purges the cursor; comment write-back, if allowed, is a separate opt-in with a recorded delivery result and retries.

## Verification floor

Tests against a recorded Linear API fake; live Linear NOT RUN without the owner's workspace.
