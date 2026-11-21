# 100 — Share a bot's setup (G16)

**Class:** C4 (import of untrusted content). **Severity:** P2. **Depends on:** 050, 060.

## Problem

There is no way to reuse a bot elsewhere (`040` ORCA-GB-08). Orca publishes a versioned package, shows the recipient exactly what will be created, and imports schedules paused (`274_orca/src/main/bots/sharing/bot-share-service.ts:222`).

## Change

1. **Format**: a `.goatbot.json` file: name, face, color, purpose, instructions, tool scope names, routines and trigger definitions (no URLs, secrets, notes, conversations or tasks). Versioned schema in `packages/contracts/src/botPackage.ts`.
2. **Export**: **Edit bot → Share → Export** downloads the file (web/desktop), share sheet (mobile).
3. **Import**: **New bot → From a file** shows a review of every field and every automation (all paused, signature secrets empty), then creates through 060's template path.
4. **Agents**: none in this unit.

## Security note

Imported text is shown before creation; nothing runs until resumed; trigger URLs are freshly minted on import. Unknown fields are dropped and listed.

## Tests (failing first)

Decode test (malformed, oversized, unknown fields); server import creates paused automations only; browser review screen lists each automation as Paused.

## Acceptance

Export from one environment and import into another produces the same bot setup with every automation paused and no secrets.

## Verification floor

Focused tests; `vp run check:changed`; independent review lane.
