import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

/**
 * A routine chip's request: the panel's Home, on this routine. A new seq is a new click; `from`
 * held focus when it was clicked, so a late row can tell whether the person has moved on.
 */
export interface GoatBotRoutineLanding {
  readonly routineId: string;
  readonly seq: number;
  readonly from: Element | null;
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
  // Only a settled, successful read says what is gone; retained data while a read runs does not.
  const settled = routines.isSuccess && !routines.isPending ? (routines.data?.tasks ?? null) : null;
  const threadId = bot?.threadId ?? null;
  // One set per list update: the React Compiler rebuilds it only when the list or thread changes.
  const known =
    settled === null
      ? null
      : new Set<string>(
          settled.filter((task) => task.threadId === threadId).map((task) => task.id),
        );
  const openRoutine = (routineId: string): (() => void) | undefined => {
    if (bot === null) return undefined;
    if (known !== null && !known.has(routineId)) return undefined;
    return () => {
      clicks.current += 1;
      setLanding({ routineId, seq: clicks.current, from: document.activeElement });
      openPanel();
    };
  };
  return { landing, openRoutine };
}
