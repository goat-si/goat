# 130 — Linear (G19)

**Class:** C4 (external account, credentials). **Severity:** P2. **Decision:** D5. **Depends on:** 010, 040.

## Problem

Orca routes Linear issues to a default bot (`274_orca/src/main/runtime/rpc/methods/bots-linear.ts:11`). GOAT has no Linear integration.

## Decision D5 (NEEDS_HUMAN)

Needs a Linear workspace and an API key or OAuth app that agents must not create. Recommendation: a personal API key entered by the owner through `handoff.create`/Settings secrets, polling assigned or labeled issues every few minutes (no public URL needed), each matching issue sent to the bound bot as a 010 `work` event with the issue fenced; replies posted as issue comments. Options: (a) API key + polling; (b) Linear webhook to the 010 trigger URL (needs a public URL until GOAT Connect); (c) defer.

## Acceptance (once D5 is answered)

An issue labeled for Scout starts a Scout task; its result is commented on the issue; an issue from an unknown requester follows the access rule chosen in D5.

## Verification floor

Focused tests against a recorded Linear API fake; live Linear NOT RUN without the owner's workspace.
