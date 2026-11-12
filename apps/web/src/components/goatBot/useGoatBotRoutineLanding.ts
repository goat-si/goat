import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

/** A routine chip's request: the panel's Home, on this routine. A new seq is a new click. */
export interface GoatBotRoutineLanding {
  readonly routineId: string;
  readonly seq: number;
}

/**
 * Where a routine chip in the chat lands. A routine is gone only once a settled, successful read
 * lacks it; while the list loads or has failed, the chip still opens the panel, as on mobile. The
 * read is the panel's own, so they share its cache.
 */
export function useGoatBotRoutineLanding(
  bot: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
  panelOpen: boolean,
  openPanel: () => void,
) {
  const routines = useEnvironmentQuery(
    bot === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId: bot.environmentId, input: {} }),
  );
  const [landing, setLanding] = useState<GoatBotRoutineLanding | null>(null);
  const clicks = useRef(0);
  // A closed panel forgets the landing, so opening it again later starts where it always does.
  if (!panelOpen && landing !== null) setLanding(null);
  const known = routines.error === null ? (routines.data?.tasks ?? null) : null;
  const openRoutine = (routineId: string): (() => void) | undefined => {
    if (bot === null) return undefined;
    const gone =
      known !== null &&
      !known.some((task) => task.id === routineId && task.threadId === bot.threadId);
    if (gone) return undefined;
    return () => {
      clicks.current += 1;
      setLanding({ routineId, seq: clicks.current });
      openPanel();
    };
  };
  return { landing, openRoutine };
}
