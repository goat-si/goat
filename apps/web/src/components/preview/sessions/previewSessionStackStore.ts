import type { EnvironmentId } from "@goat/contracts";
import { create } from "zustand";

/** Which session a caller asked the stack to show; kind alone means the first of that kind. */
export interface PreviewSessionStackFocus {
  readonly kind: "browser" | "desktop";
  readonly sessionId?: string;
}

interface PreviewSessionStackState {
  readonly collapsed: boolean;
  readonly focus: PreviewSessionStackFocus | null;
  /** Bumps on each request, so asking for the same session again scrolls to it again. */
  readonly focusRequest: number;
  readonly setCollapsed: (collapsed: boolean) => void;
}

export const usePreviewSessionStack = create<PreviewSessionStackState>()((set) => ({
  collapsed: false,
  focus: null,
  focusRequest: 0,
  setCollapsed: (collapsed) => set({ collapsed }),
}));

/**
 * Opens the agents-on-screen stack, for example from an @browser or @computer mention, and
 * brings one session's tile into view. The stack shows the environment of the thread on screen;
 * environmentId is accepted for callers that know it and is otherwise unused.
 */
export function openPreviewSessionStack(input?: {
  readonly environmentId?: EnvironmentId;
  readonly focus?: PreviewSessionStackFocus;
}): void {
  usePreviewSessionStack.setState((state) => ({
    collapsed: false,
    focus: input?.focus ?? null,
    focusRequest: state.focusRequest + 1,
  }));
}
