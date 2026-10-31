import type { FleetConnection } from "@goat/client-runtime/state/fleet-connection";
import type { FleetCloudRun } from "@goat/client-runtime/state/fleet-cloud-agents";
import type { FleetMachine, FleetThread } from "@goat/client-runtime/state/fleet";
import {
  fleetMachineSubtitle,
  fleetMachineWork,
} from "@goat/client-runtime/state/fleet-machine-description";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { RowPressable } from "../../../components/ui/RowPressable";
import { cn } from "../../../lib/cn";
import {
  ConnectionStatusDot,
  type ConnectionStatusDotState,
} from "../../connection/ConnectionStatusDot";
import { useOfflineSnapshotAge } from "../../connection/useOfflineSnapshotAge";
import { ThreadListV2WorkingSpinner } from "../../threads/thread-list-v2-row-meta";

const STATE_LABEL: Record<FleetThread["state"], string> = {
  running: "Running",
  attention: "Needs you",
  reported: "Reported",
};

const DOT_STATE: Record<FleetConnection["state"], ConnectionStatusDotState> = {
  connected: "connected",
  connecting: "connecting",
  reconnecting: "reconnecting",
  degraded: "reconnecting",
  unreachable: "available",
  offline: "available",
  stopped: "available",
  attention: "error",
  unknown: "available",
};

export function FleetMachineDot(props: { readonly connection: FleetConnection | undefined }) {
  return (
    <ConnectionStatusDot
      state={DOT_STATE[props.connection?.state ?? "unknown"]}
      pulse={false}
      size={8}
    />
  );
}

function StateIcon(props: { readonly state: FleetThread["state"] | "finished" }) {
  if (props.state === "running") {
    return <ThreadListV2WorkingSpinner tintClassName="accent-adaptive-sky-600-400" />;
  }
  return (
    <SymbolView
      name={props.state === "attention" ? "exclamationmark.circle" : "circle.dashed"}
      size={13}
      tintColorClassName={
        props.state === "attention" ? "accent-warning-foreground" : "accent-foreground-muted"
      }
      type="monochrome"
      weight="semibold"
    />
  );
}

function FleetRow(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: string;
  readonly bordered: boolean;
  readonly onPress: (() => void) | null;
  readonly accessibilityLabel: string;
}) {
  return (
    <RowPressable
      accessibilityRole={props.onPress === null ? "text" : "button"}
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.onPress === null}
      onPress={props.onPress ?? undefined}
      className={cn("bg-grouped-card", props.bordered && "border-t border-border-subtle")}
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="w-4 items-center">{props.icon}</View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={2}>
            {props.title}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {props.meta}
          </Text>
        </View>
        {props.onPress === null ? null : (
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        )}
      </View>
    </RowPressable>
  );
}

/** A running or waiting thread; tapping opens it, through the hub when that is its route. */
export function FleetThreadRow(props: {
  readonly thread: FleetThread;
  readonly bordered: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const subagents = thread.subagents.length;
  const meta = [
    STATE_LABEL[thread.state],
    thread.ref === null && thread.reportedBy !== null
      ? "Last reported by " + thread.reportedBy
      : thread.agentLabel,
    subagents === 0 ? null : subagents + (subagents === 1 ? " subagent" : " subagents"),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const ref = thread.ref;
  return (
    <FleetRow
      icon={<StateIcon state={thread.state} />}
      title={thread.title}
      meta={meta}
      bordered={props.bordered}
      onPress={ref === null ? null : () => props.onOpen(ref)}
      accessibilityLabel={thread.title + ", " + meta}
    />
  );
}

const RUN_LABEL: Record<FleetCloudRun["state"], string> = {
  running: "Running",
  finished: "Finished",
  "link-only": "Link only",
};

export function FleetCloudRunRow(props: {
  readonly run: FleetCloudRun;
  readonly bordered: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const { run } = props;
  const meta = [RUN_LABEL[run.state], run.holder, "by " + run.launchedBy].join(" · ");
  return (
    <FleetRow
      icon={<StateIcon state={run.state === "running" ? "running" : "finished"} />}
      title={run.title}
      meta={meta}
      bordered={props.bordered}
      onPress={() => props.onOpen(run.ref)}
      accessibilityLabel={run.title + ", " + meta}
    />
  );
}

/**
 * A machine with nothing running: idle when it answers, otherwise why not, with how old its
 * last state is as Connections says it. Tapping one that does not answer opens Connections.
 */
type QuietMachineProps = {
  readonly machine: FleetMachine;
  readonly connection: FleetConnection | undefined;
  readonly bordered: boolean;
  readonly onOpenConnections: () => void;
};

export function FleetQuietMachineRow(props: QuietMachineProps) {
  const environmentId = props.machine.environmentId;
  return environmentId !== null && !props.machine.answering ? (
    <AwayMachineRow {...props} environmentId={environmentId} />
  ) : (
    <QuietMachineRow {...props} age={null} />
  );
}

function AwayMachineRow(props: QuietMachineProps & { readonly environmentId: EnvironmentId }) {
  const age = useOfflineSnapshotAge(props.environmentId, false);
  return <QuietMachineRow {...props} age={age} />;
}

function QuietMachineRow(props: QuietMachineProps & { readonly age: string | null }) {
  const { machine, connection, age } = props;
  const away = machine.environmentId !== null && !machine.answering;
  const status = machine.answering
    ? fleetMachineWork(machine)
    : [connection?.label ?? fleetMachineSubtitle(machine) ?? "Not connected", age]
        .filter((part) => part !== null)
        .join(" · ");
  const subtitle = fleetMachineSubtitle(machine);
  const meta = machine.answering && subtitle !== null ? status + " · " + subtitle : status;
  return (
    <FleetRow
      icon={<FleetMachineDot connection={connection} />}
      title={machine.label}
      meta={meta}
      bordered={props.bordered}
      onPress={away ? props.onOpenConnections : null}
      accessibilityLabel={machine.label + ", " + meta}
    />
  );
}
