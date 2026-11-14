import type { ReactNode } from "react";

export const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
export const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);

export function TimelineListFooter({
  composerInset,
  children,
}: {
  readonly composerInset: number;
  readonly children?: ReactNode;
}) {
  return (
    <div>
      {children}
      <div aria-hidden style={{ height: composerInset }} />
      <div aria-hidden className="h-3 sm:h-4" />
    </div>
  );
}
