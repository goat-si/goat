import * as Option from "effect/Option";
import type { PreviewTabState } from "./Manager.ts";

export const detachDestroyedTab =
  (tabId: string, webContentsId: number) => (tabs: ReadonlyMap<string, PreviewTabState>) => {
    const current = tabs.get(tabId);
    if (current?.webContentsId !== webContentsId)
      return [Option.none<PreviewTabState>(), tabs] as const;
    const { favicon: _favicon, ...currentWithoutFavicon } = current;
    const next: PreviewTabState = { ...currentWithoutFavicon, webContentsId: null };
    const updated = new Map(tabs);
    updated.set(tabId, next);
    return [Option.some(next), updated] as const;
  };

export const replaceMap = <K, V>(
  source: ReadonlyMap<K, V>,
  update: (copy: Map<K, V>) => void,
): ReadonlyMap<K, V> => {
  const copy = new Map(source);
  update(copy);
  return copy;
};
