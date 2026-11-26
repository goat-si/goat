import type { AdvertisedEndpoint } from "@goat/contracts";
import type { ReactNode } from "react";
import { useGT } from "gt-react";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { resolveLocalVersionStatusLabel } from "./ConnectionsSettings.logic";

export const ADVANCED_CONNECTION_SETTING_IDS = [
  "hosts",
  "provider-host-matrix",
  "cloud-machines",
  "remote-launches",
  "load-balancing",
  "github-routing",
] as const;

export function LocalVersionStatusLabel() {
  const gt = useGT();
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState, gt)}
    </span>
  );
}

export function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  const gt = useGT();
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? gt("Hide") : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">{gt("Reachable at")}</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

export function formatAuthorizedClientSummary(
  clients: number,
  links: number,
  gt: ReturnType<typeof useGT>,
) {
  const clientsLabel = gt("{count, plural, one {# client} other {# clients}}", { count: clients });
  if (!links) return clientsLabel;
  const linksLabel = gt("{count, plural, one {# pairing link} other {# pairing links}}", {
    count: links,
  });
  return [clientsLabel, linksLabel].join(" · ");
}
