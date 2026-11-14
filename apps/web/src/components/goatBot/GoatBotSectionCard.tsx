import { cloneElement, type ReactElement, type ReactNode, type Ref } from "react";

import { GroupedCard } from "../ui/grouped-card";
import { cn } from "~/lib/utils";
import { ChevronRightIcon } from "../solar";
import { Skeleton } from "../ui/skeleton";

/**
 * A Home or Library section: a small muted label outside a grouped card, with at most one action
 * on the label's right. Rows inside the card draw their own dividers.
 */
export function GoatBotSectionCard({
  title,
  action = null,
  children,
  className,
}: {
  readonly title: string;
  /** The section's one trailing action, on the label's line. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2 px-1">
        <h3 tabIndex={-1} className="text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {action === null ? null : <div className="flex items-center">{action}</div>}
      </div>
      <GroupedCard radius="lg" className="overflow-hidden">
        {children}
      </GroupedCard>
    </section>
  );
}

/** A card row: a mark or icon, a title with an optional muted second line, and one trailing slot. */
export function GoatBotCardRow({
  mark = null,
  title,
  detail = null,
  trailing = null,
  onOpen,
  link,
  chevron = false,
  ariaLabel,
  expanded,
  focusRef,
}: {
  readonly mark?: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly trailing?: ReactNode;
  /** Present makes the title row a button; absent leaves the title as text. */
  readonly onOpen?: (() => void) | undefined;
  /** A link element that becomes the row's open control instead of a button. */
  readonly link?: ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  /** A trailing chevron inside the open control, so the whole row opens. */
  readonly chevron?: boolean;
  readonly ariaLabel?: string | undefined;
  readonly expanded?: boolean | undefined;
  readonly focusRef?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const body = (
    <>
      {mark === null ? null : (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {detail === null ? null : (
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
      {chevron ? (
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  const openClassName =
    "flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-2.5 px-3",
        "[&+&]:border-t [&+&]:border-border/50",
      )}
    >
      {link !== undefined ? (
        cloneElement(link, { className: openClassName, children: body })
      ) : onOpen === undefined ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>
      ) : (
        <button
          type="button"
          ref={focusRef}
          aria-label={ariaLabel}
          aria-expanded={expanded}
          onClick={onOpen}
          className={openClassName}
        >
          {body}
        </button>
      )}
      {trailing === null ? null : (
        <span className="flex shrink-0 items-center gap-1">{trailing}</span>
      )}
    </div>
  );
}

/** The centred last row of a long card list, where a person opens the rest or puts it back. */
export function GoatBotShowMoreRow({
  expanded,
  onToggle,
  label,
  buttonRef,
  onBlur,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly label?: string | undefined;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onBlur?: () => void;
}) {
  return (
    <div className="flex justify-center py-1">
      <button
        type="button"
        ref={buttonRef}
        onBlur={onBlur}
        aria-expanded={expanded}
        onClick={onToggle}
        className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {label ?? (expanded ? "Show less" : "Show more")}
      </button>
    </div>
  );
}

/** A card whose first read is out: the rows it will hold, at their real height. */
export function GoatBotCardSkeleton({ rows = 2 }: { readonly rows?: number }) {
  return (
    <div role="presentation">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-11 items-center gap-2.5 px-3 [&+&]:border-t [&+&]:border-border/50"
        >
          <Skeleton shape="pill" className="size-4 shrink-0" />
          <Skeleton shape="block" className="h-3.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}
