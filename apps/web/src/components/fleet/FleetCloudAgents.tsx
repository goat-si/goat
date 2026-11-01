import type {
  FleetCloudAgentGroup,
  FleetCloudRun,
  FleetCloudRunState,
} from "@goat/client-runtime/state/fleet-cloud-agents";
import { ProviderDriverKind } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

const RUN_LABEL: Record<FleetCloudRunState, string> = {
  running: "Running",
  finished: "Finished",
  "link-only": "Link only",
};

const RUN_DOT: Record<FleetCloudRunState, string> = {
  running: "bg-info",
  finished: "bg-muted-foreground/50",
  "link-only": "border border-dashed border-muted-foreground bg-transparent",
};

const FINISHED_LABEL: Partial<Record<FleetCloudRun["status"], string>> = {
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Cloud agent runs, one group per provider, each naming its holder and who launched it. */
export function FleetCloudAgents({
  groups,
}: {
  readonly groups: ReadonlyArray<FleetCloudAgentGroup>;
}) {
  if (groups.length === 0) return null;
  return (
    <section aria-label="Cloud agents" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Cloud agents</h2>
      {groups.map((group) => (
        <div key={group.provider} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={ProviderDriverKind.make(group.provider)}
              displayName={group.label}
              iconClassName="size-3.5"
              focusable
            />
            <span className="text-sm font-medium">{group.label}</span>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {group.running > 0 ? group.running + " running" : "Idle"}
            </span>
          </div>
          <ul className="flex flex-col">
            {group.runs.map((run) => (
              <li key={run.key}>
                <FleetCloudRunRow run={run} provider={group.provider} label={group.label} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function FleetCloudRunRow({
  run,
  provider,
  label,
}: {
  readonly run: FleetCloudRun;
  readonly provider: FleetCloudAgentGroup["provider"];
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", RUN_DOT[run.state])} />
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make(provider)}
        displayName={label}
        holder={run.holder}
        iconClassName="size-4"
        focusable
      />
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(run.ref)}
        className="min-w-0 flex-1 truncate rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {run.title}
      </Link>
      <span className="hidden min-w-0 max-w-[35%] truncate text-xs text-muted-foreground sm:inline">
        {run.branch === null ? run.repository : run.repository + " · " + run.branch}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {run.holder} · by {run.launchedBy}
      </span>
      {run.url === null ? null : (
        <a
          href={run.url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Open
        </a>
      )}
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
        {run.state === "finished"
          ? (FINISHED_LABEL[run.status] ?? RUN_LABEL.finished)
          : RUN_LABEL[run.state]}
      </span>
    </div>
  );
}
