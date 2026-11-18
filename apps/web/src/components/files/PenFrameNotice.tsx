import { cn } from "~/lib/utils";

/**
 * Stands in for a page from a Pen route: the route's URL carries its capability, and a page's
 * scripts can read their own URL, so no page from one runs in a frame until it has a URL without.
 */
export function PenFrameNotice(props: { readonly className?: string }) {
  return (
    <p
      className={cn(
        "flex items-center justify-center p-4 text-center text-muted-foreground text-xs",
        props.className,
      )}
    >
      Pages from a machine reached through Pen can't run here yet.
    </p>
  );
}
