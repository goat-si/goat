import type { PluggableList } from "unified";

export interface MarkdownSourceProps {
  text: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  /** The plugins are one of the shared sets. */
  shared: boolean;
  /** The text will not change again; streamed text would only fill the cache with prefixes. */
  cache: boolean;
}

// Cache only controls storing a new parse, so an unchanged block keeps its render.
export const sameMarkdownSource = (previous: MarkdownSourceProps, next: MarkdownSourceProps) =>
  previous.text === next.text &&
  previous.remarkPlugins === next.remarkPlugins &&
  previous.rehypePlugins === next.rehypePlugins &&
  previous.shared === next.shared;

const combinedPlugins = new WeakMap<PluggableList, WeakMap<PluggableList, PluggableList>>();

export function withExtraPlugins(shared: PluggableList, extra: PluggableList): PluggableList {
  if (extra.length === 0) return shared;
  let byShared = combinedPlugins.get(extra);
  if (!byShared) combinedPlugins.set(extra, (byShared = new WeakMap()));
  let combined = byShared.get(shared);
  if (!combined) byShared.set(shared, (combined = [...shared, ...extra]));
  return combined;
}
