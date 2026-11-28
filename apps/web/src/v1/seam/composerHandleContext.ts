// Seam for v1 apps/web/src/composerHandleContext.ts (goat 916b5ccc1b2). v1 hands menus the chat composer's handle so a
// closing menu can refocus the editor; GOAT 2's composer is not the v1 ChatComposer, so there is no handle and menus
// keep their own focus return (v1 composerEventScope.ts:20-21 handles a null handle).
import { createContext, use } from "react";

export interface ComposerHandle {
  readonly focusAtEnd: () => void;
}

export const ComposerHandleContext = createContext<{ readonly current: ComposerHandle | null } | null>(null);

export function useComposerHandleContext() {
  return use(ComposerHandleContext);
}
