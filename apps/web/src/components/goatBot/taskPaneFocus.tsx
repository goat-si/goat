import { createContext, useContext, useState, type ReactNode } from "react";

type Opener = { element: HTMLElement; key: string; taskId: string; focusOnOpen: boolean };
type FocusState = { opener: Opener | null; returning: boolean };
const TaskPaneFocusContext = createContext<FocusState | null>(null);

export function TaskPaneFocusProvider({ children }: { children: ReactNode }) {
  const [state] = useState<FocusState>(() => ({ opener: null, returning: false }));
  return <TaskPaneFocusContext value={state}>{children}</TaskPaneFocusContext>;
}

export function focusTaskHeading(
  state: FocusState | null,
  taskId: string,
  element: HTMLElement | null,
) {
  if (element && state?.opener?.taskId === taskId && state.opener.focusOnOpen) {
    state.opener.focusOnOpen = false;
    element.focus();
  }
}

export function requestTaskFocusReturn(state: FocusState | null) {
  if (state?.opener) state.returning = true;
}

export function useTaskPaneFocus() {
  return useContext(TaskPaneFocusContext);
}

export function recordTaskOpener(
  state: FocusState | null,
  element: HTMLElement,
  taskId: string,
  key: string,
) {
  if (state) {
    state.opener = { element, key, taskId, focusOnOpen: true };
    state.returning = false;
  }
}

export function restoreTaskOpener(state: FocusState | null) {
  if (!state?.returning || !state.opener) return;
  const { element, key } = state.opener;
  const replacement = Array.from(document.querySelectorAll<HTMLElement>("[data-task-opener]")).find(
    (candidate) => candidate.dataset.taskOpener === key,
  );
  const composer = document.querySelector<HTMLElement>('textarea[aria-label="Message GOAT Bot"]');
  const target = element.isConnected ? element : (replacement ?? composer);
  if (target) {
    state.returning = false;
    state.opener = null;
    target.focus();
  }
}
