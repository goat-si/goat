// Favourite models of the model picker (board 1QM8-2 star column), kept on this device like v1's favourites were
// kept per client. "instanceId/model" keys.
import { useSyncExternalStore } from "react";

const KEY = "goat2.favoriteModels";
const listeners = new Set<() => void>();
let cache: string[] | null = null;
const read = (): string[] => {
  if (cache) return cache;
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); cache = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { cache = []; }
  return cache;
};
export const favoriteKey = (instanceId: string, model: string) => `${instanceId}/${model}`;
export function toggleFavorite(key: string) {
  const list = read();
  cache = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full or blocked: keep in memory */ }
  for (const l of listeners) l();
}
export function useFavorites(): string[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, read, read);
}

