import type { FirstRunPromptId, FirstRunPromptState } from "@goat/contracts";

import { persistClientSettingsUpdate } from "../../hooks/useSettings";

/** A failed write leaves the prompt pending, so it is asked again next launch. */
export function recordFirstRunPrompt(id: FirstRunPromptId, state: FirstRunPromptState) {
  return persistClientSettingsUpdate((current) => ({
    ...current,
    firstRunPrompts: { ...current.firstRunPrompts, [id]: state },
  })).catch(() => undefined);
}
