# 080 — The phone keeps up (G12–G14)

**Class:** C4 (credential-bound persisted cache). **Severity:** P2. **Depends on:** trigger rows need 010; run labels need 070; worker context is independent.

## Problem

The phone forgets the bot list and Needs you when it closes (`apps/mobile/src/features/goat-bot/useKeptWhileOffline.ts:4`). Approval cards lack the waiting-worker count and **Open worker** Orca shows (`274_orca/mobile/src/session/native-chat/input/prompts/MobileNativeChatWorkerApproval.tsx:39`). Mobile routines already expand the instruction and offer Pause/Resume and Run now after a failure (`apps/mobile/src/features/goat-bot/MobileBotRoutines.tsx:181`); a timer routine cannot be run on demand otherwise, and webhook rows cannot be run manually at all (`ScheduledTaskService.ts:1278`).

## Change

1. **Kept summary** (C4): per pairing account and environment in `keptPerComputerStore.ts`, keep only the roster rows (name, face, counts) and minimal ask metadata (bot, kind, task id, time) — never question text, approval detail or card bodies, which the current ask carries (`packages/contracts/src/channelGateway.ts:341`). It records its read time, expires after 7 days, and is purged on sign-out, environment removal or an observed refusal. The phone learns about a remote revocation only on its next contact with the environment; the docs say so. A read that completes after sign-out or refusal cannot restore it. Offline, it shows "As of 10:42" and every mutation stays fenced.
2. **Approval context**: the bot approval card shows how many workers wait and **Open worker**, reusing `apps/mobile/src/features/threads/ChildThreadApprovals.tsx`.
3. **Routines**: timer routines get **Run now** at any time; trigger rows explain how deliveries start them instead of offering Run now.

## Tests (failing first)

Kept-store test: summary survives relaunch, holds no question text, expires, purges on revoke and on sign-out, and a late read after sign-out or refusal does not restore it. Mobile screen test beside `MobileBotRoutines`: Run now on a timer routine runs once; a trigger row has no Run now. Approval card test: "2 waiting" and Open worker.

## Acceptance

1. Cold start offline shows the last bot list and ask counts with their age, no ask text; nothing can be changed until reconnect; sign-out or refusal removes them.
2. Approving from the phone shows which workers wait and opens one.
3. Timer routines run on demand from the phone.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: iOS simulator and Android emulator captures via test-goat-mobile.
