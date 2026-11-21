# 060 — Start from a template (G10)

**Class:** C4 (wire contract for create). **Severity:** P2. **Depends on:** 010 (trigger presets), 050 (instructions).

## Problem

New bot always starts blank (`docs/user/goat-bot.md:23`). Orca seeds name, instructions, skills, paused schedules and a first-chat offer from a reviewed template (`274_orca/src/main/bots/bot-template-create.ts:24`); akeru turns a goal into an editable first message (`030` T3-08).

## Change

1. **Catalog**: GOAT-owned `packages/shared/src/goatBotTemplates.ts` with five starters: CI watcher (Check failed trigger), PR reviewer (Pull request opened trigger), Release notes (weekly routine), Standup (weekday check-in), Issue triager (webhook trigger). Each has name, face, purpose, instructions, paused routines/triggers, and a first message.
2. **Create**: the existing create input (`packages/contracts/src/channelGateway.ts:417`) gains optional `templateId`; it reuses `clientRequestId`, so a retry returns the same bot. Automations are created paused under the creating person; a failure leaves the bot with a status note "1 routine could not be added" and a **Retry** that re-runs only the missing automations, idempotently.
3. **First message**: opens as an editable draft in the composer, not sent.
4. **Clients**: **From a template** beside New bot on web/desktop (also in the command palette) and in the mobile New bot sheet, showing exactly what will be created, with every automation marked Paused.
5. **Agents**: template listing for agents belongs to 110.
6. **Docs**: `docs/user/goat-bot.md` Bots.

## Tests (failing first)

`ChannelBotMembers.test.ts`: creating from PR reviewer yields one bot and one paused trigger owned by the person; a retry with the same `clientRequestId` creates nothing new; an agent caller is refused; a failed automation can be retried once. Browser test: the picker lists automations as Paused and the first message lands as an unsent draft.

## Acceptance

1. Each template creates its bot, instructions and paused automations on web, desktop and mobile, and leaves its first message as a draft.
2. Nothing runs until the person resumes it.
3. Blank New bot is unchanged.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, web and mobile captures of the picker.
