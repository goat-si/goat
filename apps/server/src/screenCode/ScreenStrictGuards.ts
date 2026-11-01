import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ServerSettingsService } from "../serverSettings.ts";

/**
 * Whether GOAT's own input guards apply: the person's opt-in strict mode. Each read takes a
 * ticket, so a slower older read never overwrites a newer value.
 */
export interface StrictInputGuards {
  value: boolean;
  ticket: number;
  applied: number;
}

export const makeStrictInputGuards = (): StrictInputGuards => ({
  value: true,
  ticket: 0,
  applied: 0,
});

const settle = (holder: StrictInputGuards, ticket: number, strict: boolean) => {
  if (ticket <= holder.applied) return;
  holder.applied = ticket;
  holder.value = strict;
};

/** An unreadable setting keeps the guards, so a person's opt-in never fails open. */
export const refreshStrictInputGuards = (
  holder: StrictInputGuards,
  settings: ServerSettingsService["Service"] | undefined,
) => {
  if (settings === undefined) return Effect.void;
  const ticket = ++holder.ticket;
  return settings.getSettings.pipe(
    Effect.map((current) => current.cuaStrictInputGuards === true),
    Effect.orElseSucceed(() => true),
    Effect.map((strict) => settle(holder, ticket, strict)),
  );
};

/** Follows setting changes, so turning strict mode on reaches cells already running. */
export const followStrictInputGuards = (
  holder: StrictInputGuards,
  settings: ServerSettingsService["Service"],
) =>
  settings.streamChanges.pipe(
    Stream.runForEach((current) =>
      Effect.sync(() => settle(holder, ++holder.ticket, current.cuaStrictInputGuards === true)),
    ),
    Effect.forkScoped,
  );
