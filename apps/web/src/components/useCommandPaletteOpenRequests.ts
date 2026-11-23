import { type Dispatch, useEffect, useReducer } from "react";

import { captureCommandPaletteOpener, onOpenCommandPalette } from "../commandPaletteBus";
import { reduceCommandPaletteUiState } from "./CommandPalette.logic";

/** Opens the palette when another part of the app asks for it. */
export function useCommandPaletteOpenRequests(
  dispatch: Dispatch<Parameters<typeof reduceCommandPaletteUiState>[1]>,
  openAddProject: () => void,
  openNewThreadIn: () => void,
  setOpen: (open: boolean) => void,
) {
  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [dispatch, openAddProject, openNewThreadIn, setOpen],
  );
}

export function usePaletteReducer() {
  const [state, dispatchAction] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const dispatch: typeof dispatchAction = (action) => {
    if (!state.open && reduceCommandPaletteUiState(state, action).open) {
      captureCommandPaletteOpener();
    }
    dispatchAction(action);
  };
  return [state, dispatch] as const;
}
