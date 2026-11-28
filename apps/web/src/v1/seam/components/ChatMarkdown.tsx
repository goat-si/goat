// Seam (lane F): replaces v1 apps/web/src/components/ChatMarkdown.tsx @916b5cc. v1 ChatMarkdown (1.6k lines) carries file links, previews, media, math, mermaid and the environment stores. Until it
// is lifted, this renders the same props with v1's own react-markdown + remark-gfm and the caller's remark plugins, so
// the work log's thought previews (THOUGHT_PREVIEW_PLUGINS) behave as in v1. Raw HTML is never parsed.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMarkdownProps {
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  className?: string;
  parseRawHtml?: boolean;
  isStreaming?: boolean;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  [key: string]: unknown;
}

const NO_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];
const INLINE_COMPONENTS: ReactMarkdownOptions["components"] = {
  p: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
};

function ChatMarkdown({ inline, text, className, extraRemarkPlugins = NO_PLUGINS }: ChatMarkdownProps) {
  const body = (
    <ReactMarkdown remarkPlugins={[remarkGfm, ...extraRemarkPlugins]} {...(inline ? { components: INLINE_COMPONENTS } : {})}>
      {text}
    </ReactMarkdown>
  );
  return inline ? <span className={className}>{body}</span> : <div className={className}>{body}</div>;
}

export default memo(ChatMarkdown);
