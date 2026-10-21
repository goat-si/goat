import {
  HUB_TRANSPORT_LABEL,
  hubDeviceFacts,
  hubDeviceSeverity,
  type HubDevice,
  type HubSnapshot,
} from "@goat/client-runtime/state/hub-fleet";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const VERDICTS = ["broken", "degraded", "unproven", "ok"] as const;

const VERDICT_TEXT: Record<(typeof VERDICTS)[number] | "not verified", string> = {
  broken: "text-destructive",
  degraded: "text-warning",
  unproven: "text-muted-foreground",
  ok: "text-success",
  "not verified": "text-muted-foreground",
};

function verdictOf(device: HubDevice) {
  return device.parity?.verdict ?? "not verified";
}

function deviceDot(device: HubDevice) {
  const severity = hubDeviceSeverity(device);
  return severity === "destructive"
    ? "bg-destructive"
    : severity === "warning"
      ? "bg-warning"
      : verdictOf(device) === "ok"
        ? "bg-success"
        : "border border-muted-foreground";
}

/**
 * One entry for the goatclaw hub: the Home and how its devices verify. Each device's transport,
 * parity, tunnel, version, fallback and pressure sit behind +N.
 */
export function FleetHubSummary({ hub }: { readonly hub: HubSnapshot }) {
  const counts = new Map<string, number>();
  for (const device of hub.devices) {
    const verdict = verdictOf(device);
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  const severities = hub.devices.map(hubDeviceSeverity);
  const attention = severities.filter((severity) => severity !== null).length;
  const worst = severities.includes("destructive") ? "text-destructive" : "text-warning";
  return (
    <div data-fleet-hub className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-3xs uppercase tracking-widest text-muted-foreground">
          Hub
        </span>
        {hub.devices.length === 0 ? null : (
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Show ${hub.devices.length} hub ${hub.devices.length === 1 ? "device" : "devices"}`}
                  className="rounded-sm font-mono text-2xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              +{hub.devices.length}
            </PopoverTrigger>
            <PopoverPopup side="top" align="end" width="md">
              <p className="mb-2 text-xs text-muted-foreground">
                {[
                  hub.homeVersion === null ? "OpenCodex Home" : `OpenCodex ${hub.homeVersion} Home`,
                  hub.homeName,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
              <ul aria-label="Hub devices" className="flex flex-col gap-1.5">
                {hub.devices.map((device) => (
                  <li key={device.alias} className="flex items-start gap-1.5 text-xs leading-4">
                    <span
                      aria-hidden
                      className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", deviceDot(device))}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">
                        {device.alias}{" "}
                        <span className="font-normal text-muted-foreground">
                          {HUB_TRANSPORT_LABEL[device.transport]}
                        </span>
                      </span>
                      <span className="font-mono text-2xs text-muted-foreground wrap-anywhere">
                        {hubDeviceFacts(device).join(" · ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                size="xs"
                variant="ghost"
                className="mt-2"
                render={<Link to="/settings/hub" />}
              >
                Hub settings
              </Button>
            </PopoverPopup>
          </Popover>
        )}
      </span>
      <span className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate">
          {hub.homeName ?? "OpenCodex Home"}
          {hub.homeHealthy ? null : <span className="text-destructive"> · not answering</span>}
        </span>
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums">
          {hub.devices.length === 0 ? (
            <span className="text-muted-foreground">No devices</span>
          ) : attention > 0 ? (
            <span className={worst}>{attention} need attention</span>
          ) : (
            [...VERDICTS, "not verified" as const]
              .filter((verdict) => counts.has(verdict))
              .map((verdict, index) => (
                <span key={verdict} className={VERDICT_TEXT[verdict]}>
                  {index === 0 ? "" : " · "}
                  {counts.get(verdict)} {verdict}
                </span>
              ))
          )}
        </span>
      </span>
    </div>
  );
}
