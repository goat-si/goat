import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { GitBranchIcon, GitForkIcon } from "../components/solar";
import { threadEnvironment } from "../state/threads";
import { useForkThread, useThreadForkAvailability } from "./useForkThread";

const SEARCH_TERMS = ["fork", "copy", "duplicate", "branch off", "thread"];

/** "Fork thread" and, where possible, "Fork thread into new worktree" for the open thread. */
export function useForkPaletteItems(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): CommandPaletteActionItem[] {
  const threadRef = activeThread
    ? scopeThreadRef(activeThread.environmentId, activeThread.id)
    : null;
  const availability = useThreadForkAvailability(threadRef);
  const permitted = useAtomValue(
    threadEnvironment.fork.permissionAtom(threadRef?.environmentId ?? null),
  );
  const forkThread = useForkThread();
  if (threadRef === null || availability === null) return [];
  const reason = permitted ? availability.reason : "This connection cannot change threads.";
  const disabled = reason === null ? {} : { disabled: true, description: reason };
  const current: CommandPaletteActionItem = {
    kind: "action",
    value: "action:fork-thread",
    title: availability.inWorktree ? "Fork thread in same worktree" : "Fork thread",
    searchTerms: SEARCH_TERMS,
    icon: <GitForkIcon className={ITEM_ICON_CLASS} />,
    ...disabled,
    run: () => forkThread(threadRef, { type: "current" }),
  };
  if (!availability.canForkIntoWorktree) return [current];
  return [
    current,
    {
      kind: "action",
      value: "action:fork-thread-worktree",
      title: "Fork thread into new worktree",
      searchTerms: [...SEARCH_TERMS, "worktree"],
      icon: <GitBranchIcon className={ITEM_ICON_CLASS} />,
      ...disabled,
      run: () => forkThread(threadRef, { type: "worktree" }),
    },
  ];
}
