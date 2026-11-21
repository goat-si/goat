# 080 — The phone keeps up (G12–G14)

**Class:** C4 (credential-bound persisted cache). **Severity:** P2. **Depends on:** trigger rows need 010; run labels need 070; worker context is independent.

## Problem

The phone forgets the bot list and Needs you when it closes (`apps/mobile/src/features/goat-bot/useKeptWhileOffline.ts:4`). Approval cards lack the waiting-worker count and **Open worker** Orca shows (`274_orca/mobile/src/session/native-chat/input/prompts/MobileNativeChatWorkerApproval.tsx:39`). Mobile routines already expand the instruction and offer Pause/Resume and Run now after a failure (`apps/mobile/src/features/goat-bot/MobileBotRoutines.tsx:181`); a timer routine cannot be run on demand otherwise, and webhook rows cannot be run manually at all (`ScheduledTaskService.ts:1278`).

## Change

1. **Kept summary** (C4): a bounded summary (roster rows and up to 20 asks) per pairing account and environment in `keptPerComputerStore.ts`, with its read time; expires after 7 days; purged on sign-out, environment removal or access revocation. Offline, it shows "As of 10:42" and every mutation stays fenced.
2. **Approval context**: the bot approval card shows how many workers wait and **Open worker**, reusing `apps/mobile/src/features/threads/ChildThreadApprovals.tsx`.
3. **Routines**: timer routines get **Run now** at any time; trigger rows explain how deliveries start them instead of offering Run now.

## Tests (failing first)

Kept-store test: summary survives relaunch, expires, purges on revoke and on sign-out. Mobile screen test (beside `MobileBotRoutines`): Run now on a timer routine calls run once; a trigger row has no Run now. Approval card test: shows "2 waiting" and Open worker.

## Acceptance

1. Cold start offline shows the last bot list and asks with their age; nothing can be changed until reconnect; revoking access removes them.
2. Approving from the phone shows which workers wait and opens one.
3. Timer routines run on demand from the phone.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, iOS simulator captures via test-goat-mobile.
