// Seam (lane F): replaces v1 @tanstack/react-router (npm) @916b5cc. GOAT 2 has no TanStack router. Lifted rows use only <Link to="/$environmentId/$threadId">; this Link opens the thread
// through the GOAT 2 seam navigation (setV1OpenThread), keeping the anchor markup and classes the row passes.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { AnchorHTMLAttributes, ReactNode } from "react";

let openThread: ((threadId: string) => void) | null = null;
/** The GOAT 2 thread view registers how a thread opens (lane F seam). */
export function setV1OpenThread(open: ((threadId: string) => void) | null): void {
  openThread = open;
}

export interface Register {}

export function Link(props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  params?: Record<string, string>;
  children?: ReactNode;
}) {
  const { to, params, onClick, children, ...rest } = props;
  const threadId = params?.["threadId"];
  return (
    <a
      {...rest}
      href="#"
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        if (threadId && openThread) openThread(threadId);
      }}
    >
      {children}
    </a>
  );
}
