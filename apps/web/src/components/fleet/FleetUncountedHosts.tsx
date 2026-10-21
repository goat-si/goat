import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { FleetUncountedHost } from "./fleetCount";

const LISTED = 8;

/**
 * "+N" beside a machine count: hosts shown on the page that the count leaves out. A chip keeps
 * the explanation on the count's own line; the list lives in its tooltip and accessible name.
 */
export function FleetUncountedHosts(props: { readonly hosts: ReadonlyArray<FleetUncountedHost> }) {
  const { hosts } = props;
  if (hosts.length === 0) return null;
  const summary =
    hosts.length === 1
      ? "1 more host shown, not counted"
      : hosts.length + " more hosts shown, not counted";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={
              summary + ": " + hosts.map((host) => host.label + ", " + host.reason).join("; ")
            }
            className="-my-0.5 inline-flex h-4 items-center rounded-sm border px-1 align-middle font-mono text-2xs leading-none tracking-normal text-muted-foreground tabular-nums normal-case outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        +{hosts.length}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex max-w-72 flex-col gap-0.5 text-xs">
          <span className="font-medium">Only GOAT servers that answer are counted.</span>
          {hosts.slice(0, LISTED).map((host) => (
            <span key={host.key} className="truncate">
              {host.label} <span className="text-muted-foreground">· {host.reason}</span>
            </span>
          ))}
          {hosts.length > LISTED ? (
            <span className="text-muted-foreground">and {hosts.length - LISTED} more</span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
