# 050 — Each bot keeps its own memory (G09)

**Class:** C4 (persisted data layout). **Severity:** P2. **Depends on:** nothing.

## Problem

All bots on a machine share one notes file and one skill set (`docs/user/goat-bot.md:42`, `apps/server/src/channels/channelBotNotes.ts:48`). A member's purpose is injected into its brief (`channelBotSessionBrief.ts:147`), but a fact told to Scout is visible to every bot, and a bot cannot keep standing instructions longer than its purpose field. Orca keeps `SOUL.md` and `MEMORY.md` per bot with history; akeru and threebot separate private and shared memory (`030` T3-04).

## Change

1. **Storage**: member bots get a private notes file beside the shared one (same writer, same 64 KB view limit, same history), keyed by `botId`. Main keeps today's file as the shared file. No migration of existing notes: they stay shared.
2. **Server**: `channelBotNoteWriter.ts` writes a note to the bot's private file by default for member bots, and to the shared file when the person says "for all bots" (decision field `scope: "bot" | "shared"`). Recall (`channelBotNotesRecall.ts`) reads the bot's private file first, then shared.
3. **Instructions**: the profile's `purpose` stays the short description; add `instructions` (≤ 16 KB) on `BotProfile` (`packages/contracts/src/botProfile.ts:18`) edited in **Edit bot → Instructions**, injected into the brief after purpose.
4. **Web/desktop**: Library → Memory shows **This bot** and **All bots** sections; Ask to change/forget keep working per note.
5. **Mobile**: `MobileBotMemory.tsx` same two sections; instructions editable in `MobileBotEditSheet.tsx`.
6. **Docs**: goat-bot.md Memory paragraph.

## Tests (failing first)

- Notes writer test: a member bot's note lands in its private file and is not recalled by another member; a shared note is recalled by both.
- Brief test: instructions appear after purpose and are capped.
- Browser test: Memory shows both sections for a member bot.

## Acceptance

1. Tell Scout a fact; ask Review buddy: it does not know it. Ask main: it does not know it unless shared.
2. Instructions survive restart and reach the next turn.
3. Existing shared notes are unchanged and still recalled by every bot.

## Verification floor

Focused tests; `vp run check:changed`; review lane; M2 real-client pass.
