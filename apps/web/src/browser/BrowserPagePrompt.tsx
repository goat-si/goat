import type { ReactNode } from "react";

import { HoldsNavigation } from "~/lib/navigationHolds";

/** A question the page asks, over the page. While the person answers it, New bot stays put. */
export function BrowserPagePrompt(props: {
  readonly label: string;
  /** The person controls the page, so the answer is theirs to give. */
  readonly answering: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
      role="dialog"
      aria-label={props.label}
    >
      {props.answering ? <HoldsNavigation /> : null}
      {props.children}
    </div>
  );
}
