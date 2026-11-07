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
