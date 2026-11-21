# 100 — Share a bot's setup (G16)

**Class:** C4 (import of untrusted content). **Severity:** P2. **Depends on:** 050, 060, 090.

## Problem

There is no way to reuse a bot elsewhere (`040` ORCA-GB-08). Orca shows the recipient exactly what will be created and imports schedules paused (`274_orca/src/main/bots/sharing/bot-share-create.ts:32`).

## Change

1. **Format** `packages/contracts/src/botPackage.ts`: versioned `.goatbot.json` with a reviewed selection of portable fields — name, face, color, purpose, instructions, routine and trigger definitions, tool names. Never URLs, secrets, notes, conversations or tasks. Export shows the file's contents before saving, and warns when instructions or prompts contain URLs or strings that look like secrets.
2. **Import** (web/desktop first; mobile exports only): the review screen lists every field and automation. Confirmation is bound to the validated package digest. Automations import paused; a trigger that required a signature keeps that requirement and cannot be enabled until its secret is set locally (the enable path, `ScheduledTaskService.ts:1079`, gains that readiness check). Tool names are imported unmapped and disabled until the recipient maps each to a local tool. Retry with the same `clientRequestId` completes the same bot.
3. Unknown fields are dropped and listed.

## Tests (failing first)

Decode tests (malformed, oversized, unknown fields); import creates paused automations only; enabling an imported signed trigger without a secret is refused; tool grants start disabled; a retry does not duplicate.

## Acceptance

Exporting from one environment and importing into another gives the same setup with every automation paused, signatures still required, tools unmapped, and no secrets.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, web capture of the review screen.
