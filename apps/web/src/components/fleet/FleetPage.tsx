import type { FleetMachine, FleetThread } from "@goat/client-runtime/state/fleet";
import { FLEET_HEAT_LABEL, FLEET_HEAT_TIERS } from "@goat/client-runtime/state/fleet-heat";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useFleetCloudAgents, useFleetSnapshot } from "../../state/fleet";
import { useFleetHostMetrics } from "../../state/fleetHostMetrics";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsIcon } from "~/components/solar";
import { ConnectionCatalogUnreadableAlert } from "../desktop/ConnectionCatalogUnreadableNotice";
import { ConnectionEnvironmentsSection } from "../settings/ConnectionEnvironmentsSection";
import { BoatIcon } from "../Icons";
import { FleetCloudAgents } from "./FleetCloudAgents";
import { FleetConsoleSlot } from "./FleetConsoleSlot";
import { FleetGraph } from "./FleetGraph";
import { fleetMachineSubtitle } from "./describeMachine";
import { fleetConnectionLegend, UNKNOWN_FLEET_CONNECTION } from "./fleetConnection";
import { FleetConnectionIcon } from "./FleetConnectionGlyph";
import { fleetUncountedMachines } from "./fleetCount";
import { fleetHeatDemo } from "./fleetHeatDemo";
import { FleetThreadList, STATE_DOT, STATE_LABEL } from "./FleetThreadList";
import { FleetUncountedHosts } from "./FleetUncountedHosts";

const plural = (count: number, one: string, many = one + "s") =>
  count + " " + (count === 1 ? one : many);

const HEAT_DOT = {
  warm: "bg-heat-warm",
  hot: "bg-heat-hot",
  burning: "bg-heat-burning",
} as const;

/** Dev builds draw a fixed fleet in every heat tier at /fleet?fleetDemo=heat, for screenshots. */
const readHeatDemo = () =>
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("fleetDemo") === "heat"
    ? fleetHeatDemo()
    : null;

function machineWork(machine: FleetMachine): string {
  const parts = [
    machine.running > 0 ? machine.running + " running" : null,
    machine.attention > 0 ? machine.attention + " need you" : null,
    machine.reported > 0 ? machine.reported + " reported" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Idle" : parts.join(" · ");
}

const isBusy = (machine: FleetMachine) =>
  machine.running + machine.attention + machine.reported > 0;

function groupThreadsByMachine(threads: ReadonlyArray<FleetThread>) {
  const grouped = new Map<string, FleetThread[]>();
  for (const thread of threads) {
    const list = grouped.get(thread.machineId) ?? [];
    list.push(thread);
    grouped.set(thread.machineId, list);
  }
  return grouped;
}

/** Everything running across connected machines, as a graph and a list grouped by machine. */
export function FleetPage() {
  const live = useFleetSnapshot();
  const liveHeat = useFleetHostMetrics();
  const cloudAgents = useFleetCloudAgents();
  const [demo] = useState(readHeatDemo);
  const { snapshot, connections, currentMachineId, loading } =
    demo === null ? live : { ...demo, loading: false };
  const heat = demo?.heat ?? liveHeat;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMachine = snapshot.machines.find((machine) => machine.id === selected) ?? null;
  const toggleMachine = (machineId: string) =>
    setSelected((current) => (current === machineId ? null : machineId));
  const threadsByMachine = groupThreadsByMachine(snapshot.threads);
  const listed = (selectedMachine ? [selectedMachine] : snapshot.machines).filter(isBusy);
  // A host that is away or blocked is not idle; its row in Connections says why.
  const reachable = (machine: FleetMachine) => {
    const { state } = connections.get(machine.id) ?? UNKNOWN_FLEET_CONNECTION;
    return state === "connected" || state === "unknown";
  };
  const idle = selectedMachine
    ? []
    : snapshot.machines.filter((machine) => !isBusy(machine) && reachable(machine));
  const connectionLegend = fleetConnectionLegend(connections.values());
  const heatLegend = FLEET_HEAT_TIERS.flatMap((tier) =>
    tier !== "normal" && [...heat.values()].some((entry) => entry.tier === tier) ? [tier] : [],
  );
  const { totals } = snapshot;
  const uncounted = fleetUncountedMachines(snapshot.machines, connections);

  return (
    <SidebarInset>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
        <WorkspacePageHeader electron={isElectron}>
          <h1>Fleet</h1>
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            <FleetConsoleSlot snapshot={snapshot} connections={connections} heat={heat} />
            <p className="text-sm text-muted-foreground" role="status">
              {totals.running + totals.attention === 0
                ? "Nothing running on " + plural(totals.machines, "machine")
                : plural(totals.running, "thread") +
                  " running, " +
                  totals.attention +
                  " need you, on " +
                  plural(totals.machines, "machine")}
              {uncounted.length > 0 ? " " : null}
              <FleetUncountedHosts hosts={uncounted} />.
              {totals.reported > 0
                ? " " +
                  plural(totals.reported, "launch", "launches") +
                  " on SSH hosts as last reported."
                : null}
              {loading ? " Checking SSH hosts and cloud machines…" : null}
            </p>
            <section aria-label="Fleet graph" className="overflow-hidden rounded-xl border bg-card">
              <FleetGraph
                snapshot={snapshot}
                connections={connections}
                currentMachineId={currentMachineId}
                selectedMachineId={selected}
                onSelectMachine={toggleMachine}
                heat={heat}
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
                {(["running", "attention", "reported"] as const).map((state) => (
                  <span key={state} className="inline-flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-2 rounded-full", STATE_DOT[state])} />
                    {STATE_LABEL[state]}
                  </span>
                ))}
                {connectionLegend.length > 0 ? (
                  <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
                ) : null}
                {connectionLegend.map((entry) => (
                  <span key={entry.label} className="inline-flex items-center gap-1.5">
                    <FleetConnectionIcon state={entry.state} />
                    {entry.label}
                  </span>
                ))}
                {heatLegend.length > 0 ? (
                  <span aria-hidden className="hidden h-3 w-px bg-border sm:block" />
                ) : null}
                {heatLegend.map((tier) => (
                  <span key={tier} className="inline-flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-2 rounded-full", HEAT_DOT[tier])} />
                    {FLEET_HEAT_LABEL[tier]}
                  </span>
                ))}
                <span className="sm:ml-auto">Select a machine to show only its threads.</span>
              </div>
            </section>

            {selectedMachine ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  Showing <span className="font-medium">{selectedMachine.label}</span>
                  {selectedMachine.boat !== null ? (
                    <BoatIcon role="img" aria-label="Boat" className="size-3.5" />
                  ) : null}
                </span>
                <Button size="compact" variant="ghost" onClick={() => setSelected(null)}>
                  Show all
                </Button>
              </div>
            ) : null}

            {listed.map((machine) => {
              const subtitle = fleetMachineSubtitle(machine);
              return (
                <section
                  key={machine.id}
                  aria-label={machine.label}
                  className="flex flex-col gap-1"
                >
                  <button
                    type="button"
                    aria-pressed={selected === machine.id}
                    onClick={() => toggleMachine(machine.id)}
                    className="flex items-baseline gap-2 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {machine.boat !== null ? (
                      <BoatIcon aria-hidden className="size-3.5 shrink-0 self-center" />
                    ) : null}
                    <span className="text-sm font-medium">{machine.label}</span>
                    {subtitle !== null ? (
                      <span className="text-xs text-muted-foreground">{subtitle}</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {machineWork(machine)}
                    </span>
                  </button>
                  <FleetThreadList threads={threadsByMachine.get(machine.id) ?? []} />
                </section>
              );
            })}

            {idle.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Idle: {idle.map((machine) => machine.label).join(", ")}
              </p>
            ) : null}
            {selectedMachine && listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing running on this machine.</p>
            ) : null}

            {selectedMachine ? null : <FleetCloudAgents groups={cloudAgents} />}

            <ConnectionCatalogUnreadableAlert />
            <ConnectionEnvironmentsSection
              title="Connections"
              searchable={false}
              headerAction={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Connection settings"
                        render={<Link to="/settings/connections" />}
                      />
                    }
                  >
                    <SettingsIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Connection settings</TooltipPopup>
                </Tooltip>
              }
            />
          </WorkspacePageContainer>
        </main>
      </div>
    </SidebarInset>
  );
}
