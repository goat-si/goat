type Opener = { element: HTMLElement; key: string; taskId: string; focusOnOpen: boolean };
type FocusState = { opener: Opener | null; returning: boolean };
const taskPaneFocus: FocusState = { opener: null, returning: false };

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

export function getTaskPaneFocus() {
  return taskPaneFocus;
}

export function recordTaskOpener(
  state: FocusState | null,
  element: HTMLElement,
  taskId: string,
  key: string,
) {
  if (
    state &&
    !Array.from(document.querySelectorAll<HTMLElement>("[data-task-pane]")).some(
      (pane) => pane.dataset.taskPane === taskId,
    )
  ) {
    state.opener = { element, key, taskId, focusOnOpen: true };
    state.returning = false;
  }
}

export function restoreTaskOpener(state: FocusState | null) {
  if (!state?.returning || !state.opener) return;
  const { element, key } = state.opener;
  state.returning = false;
  state.opener = null;
  const replacement = Array.from(document.querySelectorAll<HTMLElement>("[data-task-opener]")).find(
    (candidate) => candidate.dataset.taskOpener === key,
  );
  const composer = document.querySelector<HTMLElement>("[data-goat-bot-composer]");
  const target = element.isConnected ? element : (replacement ?? composer);
  if (target) {
    target.focus();
  }
}
