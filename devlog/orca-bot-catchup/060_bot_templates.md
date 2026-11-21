# 060 — Start from a template (G10)

**Class:** C3. **Severity:** P2. **Depends on:** 010 (trigger presets), 050 (instructions).

## Problem

New bot always starts blank (`docs/user/goat-bot.md:23`). Orca seeds name, instructions, skills, paused schedules and a first-chat offer from a reviewed template (`274_orca/src/main/bots/bot-template-create.ts:24`); akeru turns a goal into an editable first message (`030` T3-08).

## Change

1. **Catalog**: new GOAT-owned `packages/shared/src/goatBotTemplates.ts` with five starters: **CI watcher** (Check failed trigger), **PR reviewer** (Pull request opened trigger), **Release notes** (weekly routine), **Standup** (weekday 9:00 check-in), **Issue triager** (webhook trigger). Each: name, face, purpose, instructions, routines and triggers (created **paused**), a first message.
2. **Server**: `ChannelBotMembers.ts` create accepts `templateId`; it creates the bot, then the paused routines/triggers under the creating person, in one transaction where the stores allow, else with a visible "1 routine could not be added" notice.
3. **Web/desktop**: **New bot** keeps its instant path; beside it **From a template** opens a picker showing exactly what will be created (routines paused) before **Create**.
4. **Mobile**: **New bot** sheet gains the same picker.
5. **Agents**: a read-only `goat_channel_bot_templates` listing is deferred to 110.
6. **Docs**: goat-bot.md Bots section.

## Tests (failing first)

- Server: creating from **PR reviewer** makes one bot and one paused webhook trigger owned by the person; an agent caller is refused.
- Browser: picker shows the routine as "Paused" and creates it.

## Acceptance

1. Creating from each template yields its bot, instructions and paused automations on web, desktop and mobile.
2. Nothing runs until the person resumes it.
3. Blank New bot is unchanged.

## Verification floor

Focused tests; `vp run check:changed`; review lane; M2 real-client pass.
