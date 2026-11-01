import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";

/** Whether GOAT's own input guards apply: the person's opt-in strict mode, read per cell. */
export interface StrictInputGuards {
  value: boolean;
}

export const makeStrictInputGuards = (): StrictInputGuards => ({ value: true });

/** An unreadable setting keeps the guards, so a person's opt-in never fails open. */
export const refreshStrictInputGuards = (
  holder: StrictInputGuards,
  settings: ServerSettingsService["Service"] | undefined,
) =>
  settings === undefined
    ? Effect.void
    : settings.getSettings.pipe(
        Effect.map((current) => current.cuaStrictInputGuards === true),
        Effect.orElseSucceed(() => true),
        Effect.map((strict) => {
          holder.value = strict;
        }),
      );
