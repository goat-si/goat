# 100 — Share a bot's setup (G16)

**Class:** C4 (import of untrusted content). **Severity:** P2. **Depends on:** 050, 060, 090.

## Problem

There is no way to reuse a bot elsewhere (`040` ORCA-GB-08). Orca shows the recipient exactly what will be created and imports schedules paused (`274_orca/src/main/bots/sharing/bot-share-create.ts:32`).

## Change

1. **Format** `packages/contracts/src/botPackage.ts`: versioned `.goatbot.json` with a fixed selection of portable fields — name, face, color, purpose, instructions, routine and trigger definitions, tool names. Structured credentials and endpoints are never exported: no webhook URLs, signature secrets, Slack bindings, notes, conversations or tasks.
2. **Export**: shows the file's contents before saving. A secret detector runs over free text (instructions, purpose, prompts); a match **blocks** export until the text is edited. The docs state its limit: it catches known token shapes and high-entropy strings, not every secret. Mobile can export; import is web/desktop only in this unit.
3. **Import**: the review screen lists every field and automation; confirmation is bound to the validated package digest; a retry with the same `clientRequestId` completes the same bot. Automations import paused.
4. **Signature readiness**: a persisted "signature required, secret missing" state on webhook tasks; both the upsert path (`ScheduledTaskService.ts:1079`) and the enable path (:1145) refuse to enable such a task until its secret is set locally.
5. **Tools**: imported tool names are listed but the bot's effective allowlist starts **empty** (`tools: { mcpServers: [], skills: [] }`), not absent; the recipient maps each name to a local tool to grant it.
6. Unknown fields are dropped and listed.

## Tests (failing first)

Decode tests (malformed, oversized, unknown fields); export of instructions containing a token-shaped string is blocked; import creates paused automations only; enabling an imported signed trigger without a secret is refused on both upsert and enable; an imported bot's call to a real local tool is denied until mapped; a retry does not duplicate.

## Acceptance

Exporting from one environment and importing into another gives the same setup with every automation paused, signatures still required, an empty tool allowlist, and no structured credentials or endpoints; a package whose free text contains a detected secret cannot be exported.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: web/desktop captures of export and the import review screen; iOS simulator and Android emulator capture of mobile export.
