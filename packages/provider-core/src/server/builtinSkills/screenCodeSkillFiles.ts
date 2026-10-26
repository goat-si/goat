import { SCREEN_CODE_SKILL_CORE } from "./screenCode.ts";

export const SCREEN_CODE_SKILL_DIRECTORY = "screen-code";
export const SCREEN_CODE_SKILL_FILE = "SKILL.md";

export function screenCodeSkillFiles(): Readonly<Record<string, string>> {
  return {
    [SCREEN_CODE_SKILL_FILE]: `---
name: screen-code
description: Run bounded JavaScript cells against available GOAT screen targets.
---

${SCREEN_CODE_SKILL_CORE}

Call \`goat_describe\` with \`{path:"surface.screen_run",detail:"full"}\` before the first cell to read the current input and result schemas. A cell receives the host-provided \`screen\` API. \`await screen.discover()\` lists apps, windows and tabs plus unavailable surfaces. \`await screen.tab({mentionId})\` binds one referenced tab, \`await screen.tab({tabId})\` binds one live tab by id, and \`await screen.app({bundle_id,window_id})\` binds an admitted app window. Then use \`await target.observe({screenshot:true})\` and await each target action. The host checks browser and desktop authority on each effect; a visible mention does not authorize either surface.

Observe a target before input. For a referenced tab, use its mention id; title and URL are display snapshots, and a URL-only lookup can be ambiguous. Inspect the returned journal, availability, image metadata, and any image content blocks. A cell may return partial availability when only one surface is attached. After Stop, a deadline, or an unknown outcome, observe again rather than replaying input. Keep cells short and release any target handle after use.
`,
  };
}
