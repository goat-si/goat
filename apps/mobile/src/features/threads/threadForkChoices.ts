import type { MenuAction } from "@react-native-menu/menu";
import type { OrchestrationV2ThreadForkWorkspace } from "@goat/contracts";
import type { ThreadForkAvailability } from "@goat/client-runtime/state/thread-workflows";

// Copy follows the ChatGPT desktop app's fork menu, /fork options and "Fork chat from here" dialog.
export const FORK_IN_NEW_WORKTREE_LABEL = "Fork thread in new worktree";
export const FORK_THREAD_PICKER = {
  title: "Fork thread",
  message: (inWorktree: boolean) =>
    `Fork this thread in the ${inWorktree ? "same worktree" : "current workspace"} or a new worktree.`,
};
export const FORK_RESPONSE_PICKER = { title: "Fork from here", message: undefined };

export function forkInPlaceLabel(inWorktree: boolean): string {
  return inWorktree ? "Fork thread in same worktree" : "Fork thread";
}

export interface ForkChoice {
  readonly label: string;
  readonly workspace: OrchestrationV2ThreadForkWorkspace;
}

export function forkChoices(
  inWorktree: boolean,
  source: "thread" | "response",
): readonly [ForkChoice, ForkChoice] {
  if (source === "thread") {
    return [
      { label: forkInPlaceLabel(inWorktree), workspace: { type: "current" } },
      { label: FORK_IN_NEW_WORKTREE_LABEL, workspace: { type: "worktree" } },
    ];
  }
  return [
    {
      label: inWorktree ? "Fork in this worktree" : "Fork in this workspace",
      workspace: { type: "current" },
    },
    { label: "Fork in a new worktree", workspace: { type: "worktree" } },
  ];
}

export type ForkEntryChoice =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "current" }
  | { readonly kind: "choose" };

/** What pressing a fork entry does: explain why not, fork in place, or ask where. */
export function forkEntryChoice(availability: ThreadForkAvailability): ForkEntryChoice {
  if (!availability.canFork) {
    return { kind: "blocked", reason: availability.reason ?? "This thread cannot be forked." };
  }
  return availability.canForkIntoWorktree ? { kind: "choose" } : { kind: "current" };
}

/**
 * The response button predates worktree forks and also forks side chats in place, so its
 * availability ignores the side chat and only the worktree choice is withheld from one.
 */
export function responseForkChoice(input: {
  readonly availability: ThreadForkAvailability;
  readonly isSideChat: boolean;
}): ForkEntryChoice {
  const choice = forkEntryChoice(input.availability);
  return input.isSideChat && choice.kind === "choose" ? { kind: "current" } : choice;
}

const FORK_IMAGE = "arrow.triangle.branch";

/** The thread-list menu entry; null hides it. */
export function buildForkMenuActions(availability: ThreadForkAvailability | null): MenuAction[] {
  if (availability === null) return [];
  const state = {
    image: FORK_IMAGE,
    attributes: { disabled: !availability.canFork },
    ...(availability.reason === null ? {} : { subtitle: availability.reason }),
  };
  const inPlace = { id: "fork:current", title: forkInPlaceLabel(availability.inWorktree) };
  if (!availability.canForkIntoWorktree) return [{ ...inPlace, ...state }];
  return [
    {
      id: "fork",
      title: "Fork thread",
      ...state,
      subactions: [inPlace, { id: "fork:worktree", title: FORK_IN_NEW_WORKTREE_LABEL }],
    },
  ];
}

export function forkWorkspaceForMenuEvent(
  event: string,
): OrchestrationV2ThreadForkWorkspace | null {
  if (event === "fork:current") return { type: "current" };
  if (event === "fork:worktree") return { type: "worktree" };
  return null;
}
