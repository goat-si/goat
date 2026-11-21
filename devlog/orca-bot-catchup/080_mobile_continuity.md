# 080 — The phone keeps up (G12–G14)

**Class:** C3. **Severity:** P2. **Depends on:** 010 (trigger rows), 030 (alert targets).

## Problem

The phone forgets the bot list and **Needs you** when it closes (`apps/mobile/src/features/goat-bot/useKeptWhileOffline.ts:4`); approval cards lack the waiting-worker count and **Open worker** that Orca shows (`274_orca/mobile/src/session/native-chat/input/prompts/MobileNativeChatWorkerApproval.tsx:39`); a routine's instruction and **Run now** are not reachable from the phone (`030` T3-09).

## Change

1. **Kept snapshot**: persist the roster and Needs you per environment in the app's existing storage (`keptPerComputerStore.ts`), with the time it was read; show "As of 10:42" while offline; purge when the environment is removed or access is revoked; mutations stay fenced while offline.
2. **Approval context**: the bot approval card shows how many workers wait and **Open worker** (the child thread), reusing `ChildThreadApprovals.tsx`.
3. **Routine detail**: tapping a routine opens a sheet with its instruction, schedule or trigger, timezone, recent runs (with 070's labels) and **Run now** / **Pause**.

## Tests (failing first)

- Kept-store test: snapshot survives a simulated relaunch and is purged on revoke.
- Screen test: approval card shows "2 waiting" and Open worker; routine sheet runs Run now once.

## Acceptance

1. Cold-start offline shows the last bot list and asks with their age; nothing can be changed until reconnect.
2. Approving from the phone shows which worker waits and opens it.
3. A routine can be read, paused and run from the phone.

## Verification floor

Focused tests; `vp run check:changed`; review lane; test-goat-mobile pass on the iOS simulator (M2).
