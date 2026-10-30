import { formatWorkingDurationLabel } from "@goat/client-runtime/state/models";
import { createContext, use } from "react";

import { useVisibleSecondClock } from "./use-visible-second-clock";

/**
 * A list pane that stays on screen while its route loses focus to an open thread: the iPad
 * sidebar, while the layout shows it. Its labels tick without focus only while it is shown.
 */
export const ThreadListPaneVisibleContext = createContext(false);

/** Elapsed time after a Working or Waiting label. */
export function ThreadListV2Duration(props: { readonly startedAt: string | null }) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs), {
    whileUnfocused: use(ThreadListPaneVisibleContext),
  });
  if (!Number.isFinite(startedAtMs)) return null;
  return ` ${formatWorkingDurationLabel(nowMs - startedAtMs)}`;
}
