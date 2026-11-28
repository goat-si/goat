// Seam for the npm module @tanstack/react-router, which lifted v1 files import (settingsLayout, ModelPickerProviderNotices).
// GOAT 2 has its own navigation (apps/web/src/ui-state), so this module answers v1's two hooks: useLocation reads the
// location the GOAT 2 frame sets, and useNavigate hands v1 paths to the GOAT 2 frame (setGoat2Navigator).
import { useSyncExternalStore } from "react";

export interface HistoryState {}

export interface Goat2Location {
  readonly pathname: string;
  readonly hash: string;
  readonly search: Record<string, unknown>;
  readonly state: HistoryState & { readonly settingsTargetHighlight?: boolean };
}

export interface NavigateOptions {
  readonly to?: string;
  readonly hash?: string;
  readonly search?: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>);
  readonly replace?: boolean;
  readonly state?: HistoryState;
  readonly hashScrollIntoView?: boolean;
  readonly resetScroll?: boolean;
}

let location: Goat2Location = { pathname: "/settings/providers", hash: "", search: {}, state: {} };
const listeners = new Set<() => void>();
let navigator: (options: NavigateOptions) => void = () => {};

/** The GOAT 2 frame tells v1 code where it is and how to move. */
export function setGoat2Location(next: Goat2Location): void {
  location = next;
  for (const listener of listeners) listener();
}

export function setGoat2Navigator(next: (options: NavigateOptions) => void): void {
  navigator = next;
}

export function useLocation<T = Goat2Location>(options?: { readonly select?: (location: Goat2Location) => T }): T {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => location,
  );
  return options?.select ? options.select(current) : (current as T);
}

export function useNavigate() {
  return (options: NavigateOptions) => {
    navigator(options);
    return Promise.resolve();
  };
}
