# 050 — Each bot keeps its own memory (G09)

**Class:** C4 (persisted data, authority). **Severity:** P2. **Depends on:** nothing.

## Problem

All bots on a machine share one notes file and skill set (`docs/user/goat-bot.md:42`). The notes reader takes no bot (`apps/server/src/channels/ChannelBotNotesReader.ts:66`), and reception, the bot session, local workers and remote workers each read notes on their own paths; reception reads notes before it evaluates the live viewer (`ChannelReceptionService.ts:1020`, :1086). A member's purpose reaches its brief (`channelBotSessionBrief.ts:147`), but there is nowhere for longer standing instructions. Orca keeps `SOUL.md` and `MEMORY.md` per bot; akeru and threebot separate private and shared memory (`030` T3-04).

## Meaning of "private"

Scoped recall and editing: a member bot's notes are read, recalled, edited and forgotten only through that bot, and only for a person allowed to use GOAT memory. It is not filesystem isolation — a full-access worker on the machine could read the file — and the docs say so.

## Change

1. **Two checks before notes enter any model input**: the reader, recall, editors and worker briefs take the `botId` of the authorized task or reader **and** the live viewer's memory permission; both must pass. Carried through `ChannelBotNotesReader.list`, `channelBotNotesRecall.ts`, `channelBotNoteWriter.ts`, `channelBotNoteTabEdits.ts`, reception (`ChannelReceptionService.ts:1020`), `channelWorkerBrief.ts` and `ChannelRemoteWorkers.ts`. Reception evaluates the viewer before reading notes.
2. **Storage**: member bots get a private notes file beside the shared one (same 64 KB view, history and replacement rules). Existing notes stay shared; no migration of content.
3. **Writes**: member bots write private notes by default; a shared note needs the person's explicit "for all bots" confirmation in the reply card.
4. **Instructions**: `BotProfile.instructions` (≤ 16 KB, `packages/contracts/src/botProfile.ts:18`), edited in Edit bot → Instructions; a change rotates the bot's warm session (`channelBotSessionRotation.ts`) so the next turn uses it; older servers hide the field (capability-gated like other optional profile fields, `packages/contracts/src/channelGateway.ts:402`).
5. **Clients**: Library → Memory shows **This bot** and **All bots** on web/desktop and mobile (`MobileBotMemory.tsx`); instructions editable on both.
6. **Docs**: `docs/user/goat-bot.md` Memory.

## Tests (failing first)

`ChannelBotNotesReader.test.ts`, `ChannelBotNotesRecall.test.ts`, `channelBotNotes.test.ts`: a member's note is listed and recalled for it and not for another member or main; a shared note reaches all; forget on bot A cannot touch bot B's note; a worker brief for bot A contains only A's private and shared notes; a viewer without memory permission gets neither, even when routed to A; an instructions change rotates the warm session.

## Acceptance

1. Tell Scout a fact; Review buddy and main do not know it unless it was shared.
2. A sender without memory access never causes notes to enter a model input.
3. Instructions reach the next turn after an edit, on every path that runs the bot.
4. Existing shared notes are unchanged and recalled by every bot.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: web/desktop and iOS simulator captures of the two Memory sections and the instructions field.
