import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface OnboardingNode {
  readonly id: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string | undefined;
  /** Something the answer does not change right away, drawn quieter and joined by a dashed line. */
  readonly later?: boolean;
}

/**
 * The connection a first-run question would make, drawn once when the dialog opens: the
 * machines and agents involved, joined in order. The description says the same in words, so
 * this stays hidden from assistive technology.
 */
export function OnboardingLink({ nodes }: { readonly nodes: readonly OnboardingNode[] }) {
  return (
    <div
      aria-hidden
      className="flex items-start justify-center rounded-xl bg-foreground/[0.03] px-3 pt-5 pb-4 ring-1 ring-border/60 ring-inset dark:bg-white/[0.025]"
    >
      {nodes.map((node, index) => (
        <Fragment key={node.id}>
          {index > 0 ? <Connector later={node.later === true} delayMs={index * 90} /> : null}
          <div
            className="goat-arrive flex w-[5.5rem] shrink-0 flex-col items-center text-center"
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <span
              className={cn(
                "grid size-11 place-items-center rounded-full [&_svg]:size-5",
                node.later
                  ? "border border-dashed border-border text-muted-foreground"
                  : "bg-background text-foreground shadow-xs ring-1 ring-border dark:bg-white/[0.06] dark:shadow-none",
              )}
            >
              {node.icon}
            </span>
            <span
              className={cn(
                "mt-2 max-w-full truncate text-xs leading-4 font-medium",
                node.later ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {node.label}
            </span>
            {node.detail ? (
              <span className="max-w-full truncate text-2xs text-muted-foreground">
                {node.detail}
              </span>
            ) : null}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function Connector({ later, delayMs }: { readonly later: boolean; readonly delayMs: number }) {
  return (
    <span
      className={cn(
        "relative mt-[1.375rem] h-0 min-w-5 flex-1 border-t",
        later ? "border-dashed border-border" : "border-foreground/20",
      )}
    >
      {later ? null : (
        <span
          className="goat-onboarding-signal absolute inset-x-0 -top-px h-0"
          style={{ animationDelay: `${160 + delayMs}ms` }}
        >
          <span className="absolute top-0 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
        </span>
      )}
    </span>
  );
}
