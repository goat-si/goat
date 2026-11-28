// Local UI state (structure/20_data.md ui-state.json: visits, read marks, pin order). Kept in
// localStorage until the host serves ui-state.json; never thread history.
import { useCallback, useSyncExternalStore } from "react";

export interface UiState {
  mode: "bots" | "threads" | "settings";
  botId: string;
  sidebarOpen: boolean;
  panelOpen: boolean;
  /** Worker thread open in the right panel (bot mode). */
  panelThreadId: string | null;
  /** Thread open in thread mode. */
  threadId: string | null;
  pinned: string[];
  /** Bots added to the rail from "…" (the main bot is always there). */
  railBots: string[];
  readMarks: Record<string, string>;
  /** Settings page path in settings mode (v1 SettingsPath, e.g. "/settings/providers") and its search (?instanceId=). */
  settingsPath?: string;
  settingsSearch?: Record<string, string>;
  /** Providers switched off from their detail page; they stay in the Providers list (providers/view.ts isAdded). */
  providersKeptOff?: string[];
}

export const DEFAULT_UI: UiState = {
  mode: "bots", botId: "main", sidebarOpen: true, panelOpen: true, panelThreadId: null, threadId: null,
  pinned: [], railBots: [], readMarks: {},
};

type Listener = () => void;
export class UiStore {
  private state: UiState;
  private listeners = new Set<Listener>();
  private readonly key: string | null;
  constructor(initial: Partial<UiState>, key: string | null) {
    this.key = key;
    let saved: Partial<UiState> = {};
    if (key) { try { saved = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { saved = {}; } }
    this.state = { ...DEFAULT_UI, ...saved, ...initial };
  }
  get = () => this.state;
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  set = (patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    if (this.key) { try { localStorage.setItem(this.key, JSON.stringify(this.state)); } catch { /* ignore */ } }
    for (const l of this.listeners) l();
  };
}

export function pin(s: UiState, botId: string, index?: number): Partial<UiState> {
  const rest = s.pinned.filter((id) => id !== botId);
  const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length));
  return { pinned: [...rest.slice(0, at), botId, ...rest.slice(at)] };
}
export const unpin = (s: UiState, botId: string): Partial<UiState> => ({ pinned: s.pinned.filter((id) => id !== botId) });
export const addToRail = (s: UiState, botId: string): Partial<UiState> => (s.railBots.includes(botId) ? {} : { railBots: [...s.railBots, botId] });
export const removeFromRail = (s: UiState, botId: string): Partial<UiState> => ({ railBots: s.railBots.filter((id) => id !== botId) });

export function useUi(store: UiStore): [UiState, UiStore["set"]] {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const set = useCallback(store.set, [store]);
  return [state, set];
}
