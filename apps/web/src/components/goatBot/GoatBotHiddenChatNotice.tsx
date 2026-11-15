import { useId, type ReactNode } from "react";

import { usePausedNavigationHolds } from "~/lib/navigationHolds";

const UNSAVED_BEHIND =
  "The chat behind this task has open or unsaved work. Leaving this task closes it and discards unsaved changes.";

/**
 * While a task replaces the chat, says beside the control that leaves when the chat holds open or
 * unsaved work, and describes that control with it. The live region stays mounted so the change is read.
 */
export function useGoatBotHiddenChatNotice(chatHidden: boolean): {
  readonly describedBy: string | undefined;
  readonly notice: ReactNode;
} {
  const id = useId();
  const paused = usePausedNavigationHolds();
  const unsaved = chatHidden && paused > 0;
  return {
    describedBy: unsaved ? id : undefined,
    notice: (
      <p
        id={id}
        role="status"
        className={unsaved ? "order-last w-full text-xs text-muted-foreground" : "sr-only"}
      >
        {unsaved ? UNSAVED_BEHIND : ""}
      </p>
    ),
  };
}
