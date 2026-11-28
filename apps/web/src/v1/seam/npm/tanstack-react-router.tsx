// Seam for the npm module @tanstack/react-router, which lifted v1 files import (settingsLayout, ModelPickerProviderNotices, TimelineWorkEntryRow, lib/sentFromNavigation).
// GOAT 2 has its own navigation (apps/web/src/ui-state), so this module answers v1's two hooks: useLocation reads the
// location the GOAT 2 frame sets, and useNavigate hands v1 paths to the GOAT 2 frame (setGoat2Navigator).
import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";

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

/** v1's router register interface; lifted files augment it (lib/sentFromNavigation.ts). */
export interface Register {}

/**
 * v1 <Link to="/$environmentId/$threadId" params>: the path is resolved with its params and handed to the GOAT 2
 * navigator, so a timeline "read thread" link opens the thread through the GOAT 2 frame (lane F). Markup and classes
 * are the ones the lifted row passes.
 */
export function Link(
  props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    readonly to: string;
    readonly params?: Record<string, string>;
    readonly children?: ReactNode;
  },
) {
  const { to, params, onClick, children, ...rest } = props;
  const path = to.replace(/\$([A-Za-z]+)/g, (whole, name: string) => params?.[name] ?? whole);
  return (
    <a
      {...rest}
      href={path}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigator({ to: path });
      }}
    >
      {children}
    </a>
  );
}
