import { useAtomValue } from "@effect/atom-react";
import type { FleetThread } from "@goat/client-runtime/state/fleet";
import {
  fleetMachineSubtitle,
  fleetMachineWork,
  isFleetMachineBusy,
} from "@goat/client-runtime/state/fleet-machine-description";
import type { ScopedThreadRef } from "@goat/contracts";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { use } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ListSection } from "../../../components/ui/ListSection";
import { useAppActive } from "../../../lib/appState";
import { NativeWorkspaceTabActivityContext } from "../../../native/v5-workspace-context";
import { mobileFleet } from "../../../state/fleet";
import { environmentPresentations } from "../../../state/presentation";
import { useAdaptiveWorkspaceLayout } from "../../layout/adaptive-workspace-context";
import { HubAccessNotice } from "../../settings/HubAccessNotice";
import { openSettings } from "../../settings/settings-navigation";
import { useSelectWorkspaceDetail } from "../../workspace/useSelectWorkspaceDetail";
import {
  FleetCloudRunRow,
  FleetMachineDot,
  FleetQuietMachineRow,
  FleetThreadRow,
} from "./usageFleetRows";

const plural = (count: number, one: string, many = one + "s") =>
  count + " " + (count === 1 ? one : many);

/**
 * The Usage screen's Fleet tab: what runs on every machine this phone reaches, as the web's Fleet
 * page counts it. It reads nothing while the screen is covered, its retained iOS workspace tab is
 * hidden, or the app is in the background.
 */
export default function UsageFleetSection() {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  return focused && appActive && tabActive ? <FleetContent /> : null;
}

function FleetContent() {
  const { snapshot, connections, loading } = useAtomValue(mobileFleet.fleetPageAtom);
  const cloudAgents = useAtomValue(mobileFleet.fleetCloudAgentsAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const openThread = (ref: ScopedThreadRef) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(ref.environmentId), threadId: String(ref.threadId) },
    });
  const openConnections = () => openSettings(navigation, "SettingsEnvironments");

  const threadsByMachine = new Map<string, FleetThread[]>();
  for (const thread of snapshot.threads) {
    const list = threadsByMachine.get(thread.machineId) ?? [];
    list.push(thread);
    threadsByMachine.set(thread.machineId, list);
  }
  const busy = snapshot.machines.filter(isFleetMachineBusy);
  const quiet = snapshot.machines.filter((machine) => !isFleetMachineBusy(machine));
  const { totals } = snapshot;
  const notConnected = snapshot.machines.filter((machine) => !machine.answering).length;
  const hubs = [...presentations].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.settings.hub.enabled === true,
  );
  const details = [
    notConnected > 0 ? notConnected + " not connected" : null,
    totals.reported > 0
      ? plural(totals.reported, "launch", "launches") + " on SSH hosts as last reported"
      : null,
    loading ? "Checking SSH hosts and cloud machines…" : null,
  ].filter((part) => part !== null);

  return (
    <View className="gap-6">
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={
          plural(totals.running, "thread") +
          " running, " +
          totals.attention +
          " need you, on " +
          plural(totals.machines, "machine")
        }
        className="gap-2"
      >
        <ListSection>
          <View className="flex-row">
            <FleetMetric label="Running" value={totals.running} />
            <FleetMetric label="Need you" value={totals.attention} />
            <FleetMetric label="Machines" value={totals.machines} />
          </View>
        </ListSection>
        {details.length > 0 ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {details.join(" · ")}
          </Text>
        ) : null}
      </View>

      {hubs.map(([environmentId, presentation]) => (
        <HubAccessNotice
          key={environmentId}
          environmentId={environmentId}
          label={presentation.entry.target.label}
        />
      ))}

      {totals.machines === 0 ? (
        <EmptyState
          title="No machine connected"
          detail="Fleet lists the threads running on the machines this phone is connected to. Check your network, or reconnect in Connections."
          actionLabel="Open Connections"
          onAction={openConnections}
        />
      ) : busy.length === 0 ? (
        <EmptyState
          title="Nothing running"
          detail={"No thread is running on your " + plural(totals.machines, "machine") + "."}
          actionLabel="New thread"
          onAction={startNewTask}
        />
      ) : null}

      {busy.map((machine) => {
        const threads = threadsByMachine.get(machine.id) ?? [];
        const subtitle = fleetMachineSubtitle(machine);
        return (
          <ListSection
            key={machine.id}
            title={machine.label}
            titleIcon={<FleetMachineDot connection={connections.get(machine.id)} />}
            trailing={
              <Text textRole="footnote" className="px-2 tabular-nums text-foreground-muted">
                {fleetMachineWork(machine)}
              </Text>
            }
            footer={subtitle ?? undefined}
          >
            {threads.map((thread, index) => (
              <FleetThreadRow
                key={thread.key}
                thread={thread}
                bordered={index > 0}
                onOpen={openThread}
              />
            ))}
          </ListSection>
        );
      })}

      {cloudAgents.map((group) => (
        <ListSection
          key={group.provider}
          title={group.label}
          trailing={
            <Text textRole="footnote" className="px-2 tabular-nums text-foreground-muted">
              {group.running > 0 ? group.running + " running" : "Idle"}
            </Text>
          }
        >
          {group.runs.map((run, index) => (
            <FleetCloudRunRow key={run.key} run={run} bordered={index > 0} onOpen={openThread} />
          ))}
        </ListSection>
      ))}

      {quiet.length > 0 ? (
        <ListSection title={busy.length === 0 ? "Machines" : "Other machines"}>
          {quiet.map((machine, index) => (
            <FleetQuietMachineRow
              key={machine.id}
              machine={machine}
              connection={connections.get(machine.id)}
              bordered={index > 0}
              onOpenConnections={openConnections}
            />
          ))}
        </ListSection>
      ) : null}
    </View>
  );
}

function FleetMetric(props: { readonly label: string; readonly value: number }) {
  return (
    <View className="flex-1 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-goat-medium tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
}
