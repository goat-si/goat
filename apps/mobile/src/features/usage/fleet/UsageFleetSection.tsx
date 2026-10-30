import { useAtomValue } from "@effect/atom-react";
import type { FleetThread } from "@goat/client-runtime/state/fleet";
import {
  fleetMachineSubtitle,
  fleetMachineWork,
  isFleetMachineBusy,
} from "@goat/client-runtime/state/fleet-machine-description";
import type { ScopedThreadRef } from "@goat/contracts";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { use, useState } from "react";
import { useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
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
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { showsFleetGraph } from "./fleetGraphText";
import { UsageFleetGraph } from "./UsageFleetGraph";
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
  const { fontScale } = useWindowDimensions();
  const { baseFontSize } = useAppearancePreferences().appearance;
  const graphShown = showsFleetGraph({ baseFontSize, fontScale });
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const { startNewTask } = useAdaptiveWorkspaceLayout();
  const openThread = (ref: ScopedThreadRef) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(ref.environmentId), threadId: String(ref.threadId) },
    });
  const openConnections = () => openSettings(navigation, "SettingsEnvironments");
  const [selection, setSelection] = useState<string | null>(null);
  // A machine that left the Fleet is no longer a filter.
  const selected = snapshot.machines.find((machine) => machine.id === selection) ?? null;
  const toggleMachine = (machineId: string) =>
    setSelection(selected?.id === machineId ? null : machineId);

  const threadsByMachine = new Map<string, FleetThread[]>();
  for (const thread of snapshot.threads) {
    const list = threadsByMachine.get(thread.machineId) ?? [];
    list.push(thread);
    threadsByMachine.set(thread.machineId, list);
  }
  const listed = selected === null ? snapshot.machines : [selected];
  const busy = listed.filter(isFleetMachineBusy);
  const quiet = listed.filter((machine) => !isFleetMachineBusy(machine));
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
          <FleetMetrics
            metrics={[
              ["Running", totals.running],
              ["Need you", totals.attention],
              ["Machines", totals.machines],
            ]}
          />
        </ListSection>
        {details.length > 0 ? (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {details.join(" · ")}
          </Text>
        ) : null}
      </View>

      {snapshot.machines.length > 0 && graphShown ? (
        <UsageFleetGraph
          snapshot={snapshot}
          connections={connections}
          selectedMachineId={selected?.id ?? null}
          onSelectMachine={toggleMachine}
          onOpenThread={openThread}
        />
      ) : null}

      {selected !== null ? (
        <View className="flex-row items-center justify-between gap-3 px-2">
          <Text className="min-w-0 shrink text-sm text-foreground" numberOfLines={1}>
            {"Showing " + selected.label}
          </Text>
          <Button label="Show all" tone="secondary" onPress={() => setSelection(null)} />
        </View>
      ) : null}

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
      ) : selected === null && busy.length === 0 ? (
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

      {(selected === null ? cloudAgents : []).map((group) => (
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
        <ListSection
          title={
            selected !== null
              ? "Nothing running"
              : busy.length === 0
                ? "Machines"
                : "Other machines"
          }
        >
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

/** Three columns, or one row per total at large text sizes, where a third of the width breaks words. */
function FleetMetrics(props: { readonly metrics: ReadonlyArray<readonly [string, number]> }) {
  const { fontScale } = useWindowDimensions();
  if (fontScale >= 1.5) {
    return props.metrics.map(([label, value], index) => (
      <View
        key={label}
        className={
          index > 0
            ? "flex-row items-center justify-between gap-3 border-t border-border-subtle px-4 py-3"
            : "flex-row items-center justify-between gap-3 px-4 py-3"
        }
      >
        <Text className="shrink text-sm text-foreground-muted">{label}</Text>
        <Text className="text-xl font-goat-medium tabular-nums text-foreground">{value}</Text>
      </View>
    ));
  }
  return (
    <View className="flex-row">
      {props.metrics.map(([label, value]) => (
        <View key={label} className="flex-1 gap-0.5 p-4">
          <Text className="text-sm text-foreground-muted">{label}</Text>
          <Text className="text-xl font-goat-medium tabular-nums text-foreground">{value}</Text>
        </View>
      ))}
    </View>
  );
}
