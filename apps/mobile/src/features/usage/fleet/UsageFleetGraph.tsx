import type { FleetConnection } from "@goat/client-runtime/state/fleet-connection";
import type {
  FleetAgent,
  FleetMachine,
  FleetSnapshot,
  FleetThread,
} from "@goat/client-runtime/state/fleet";
import {
  COMPACT_GRAPH_LIMITS,
  compactGraphHeight,
  layoutFleet,
  type FleetAggregate,
} from "@goat/client-runtime/state/fleet-layout";
import { fleetMachineWork } from "@goat/client-runtime/state/fleet-machine-description";
import type { ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Ellipse, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { EnvironmentMachineSymbol } from "../../../components/EnvironmentMachineSymbol";
import { GoatWordmark } from "../../../components/GoatWordmark";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { AppText as Text } from "../../../components/ui/AppText";
import { FleetMachineDot } from "./usageFleetRows";

type Work = Pick<FleetMachine, "running" | "attention" | "reported">;
type Tone = "attention" | "running" | "idle" | "away";

const LABEL_WIDTH = 84;

const toneOf = (work: Work, answering: boolean): Tone =>
  work.attention > 0
    ? "attention"
    : work.running + work.reported > 0
      ? "running"
      : answering
        ? "idle"
        : "away";

function useToneColors(): Record<Tone, string> {
  const running = useResolveClassNames("text-adaptive-sky-600-400").color;
  const attention = useResolveClassNames("text-warning-foreground").color;
  const idle = useResolveClassNames("text-foreground-muted").color;
  const away = useResolveClassNames("text-foreground-tertiary").color;
  const asString = (value: unknown, fallback: string) =>
    typeof value === "string" ? value : fallback;
  return {
    running: asString(running, "#0284c7"),
    attention: asString(attention, "#b45309"),
    idle: asString(idle, "#737373"),
    away: asString(away, "#a3a3a3"),
  };
}

const plural = (count: number, one: string) => count + " " + one + (count === 1 ? "" : "s");

function describeWork(work: Work): string {
  return fleetMachineWork(work).replace(" · ", ", ");
}

/**
 * Fleet's graph sized for a phone: machines on an orbit around GOAT and the agents working on
 * each beside it, from the same layout as the web graph. It is drawn once per change, with no
 * motion: a ring's color says running or waiting. Tapping a machine shows only its threads;
 * tapping an agent opens its thread when it has one, else shows its machine.
 */
export function UsageFleetGraph(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly selectedMachineId: string | null;
  readonly onSelectMachine: (machineId: string) => void;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const [width, setWidth] = useState(0);
  const colors = useToneColors();
  const border = useResolveClassNames("border-border").borderColor;
  const orbitColor = typeof border === "string" ? border : colors.away;
  const height = compactGraphHeight(width);
  const wide = width >= 600;
  const machineRadius = wide ? 20 : 16;
  const agentRadius = wide ? 13 : 11;
  const layout =
    width > 0 ? layoutFleet(props.snapshot.machines, width, height, COMPACT_GRAPH_LIMITS) : null;
  const machinesById = new Map(props.snapshot.machines.map((machine) => [machine.id, machine]));
  const threadsByAgent = new Map<string, FleetThread[]>();
  for (const thread of props.snapshot.threads) {
    const key = thread.machineId + "\n" + thread.agentKey;
    threadsByAgent.set(key, [...(threadsByAgent.get(key) ?? []), thread]);
  }
  const { totals } = props.snapshot;

  return (
    <View
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
      style={{ height }}
      accessibilityLabel={
        "Fleet graph: " +
        plural(totals.machines, "machine") +
        ", " +
        totals.running +
        " running, " +
        totals.attention +
        " need you"
      }
    >
      {layout === null ? null : (
        <>
          <Svg
            width={width}
            height={height}
            style={{ position: "absolute" }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Ellipse
              cx={layout.center.x}
              cy={layout.center.y}
              rx={layout.inner.rx}
              ry={layout.inner.ry}
              fill="none"
              stroke={orbitColor}
              strokeDasharray="2 6"
            />
            <Ellipse
              cx={layout.center.x}
              cy={layout.center.y}
              rx={layout.outer.rx}
              ry={layout.outer.ry}
              fill="none"
              stroke={orbitColor}
              strokeOpacity={0.6}
              strokeDasharray="1 9"
            />
            {layout.machines.map((node) => {
              const machine = node.id === null ? undefined : machinesById.get(node.id);
              const work: Work = machine ?? node.aggregate ?? NO_WORK;
              const tone = toneOf(work, machine?.answering ?? true);
              return (
                <Path
                  key={"edge:" + (node.id ?? "more")}
                  d={node.edge}
                  fill="none"
                  stroke={tone === "idle" ? orbitColor : colors[tone]}
                  strokeOpacity={tone === "running" || tone === "attention" ? 0.6 : 1}
                  strokeWidth={tone === "running" || tone === "attention" ? 1.6 : 1.2}
                  strokeDasharray={tone === "away" ? "1 5" : undefined}
                />
              );
            })}
          </Svg>
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: "absolute",
              left: layout.center.x - 30,
              top: layout.center.y - 9,
              width: 60,
              alignItems: "center",
            }}
          >
            <GoatWordmark height={18} colorClassName="accent-foreground" />
          </View>
          {layout.machines.flatMap((node) => {
            const machine = node.id === null ? undefined : machinesById.get(node.id);
            const machineId = machine?.id ?? null;
            const agents = node.agents.map((agentNode) => {
              const agent = machine?.agents.find((candidate) => candidate.key === agentNode.key);
              const threads =
                machine === undefined || agent === undefined
                  ? []
                  : (threadsByAgent.get(machine.id + "\n" + agent.key) ?? []);
              const only = threads.length === 1 ? threads[0]?.ref : null;
              return (
                <AgentNode
                  key={"agent:" + (node.id ?? "more") + ":" + agentNode.key}
                  x={agentNode.x}
                  y={agentNode.y}
                  radius={agentRadius}
                  agent={agent ?? null}
                  aggregate={agentNode.aggregate}
                  machineLabel={machine?.label ?? ""}
                  colors={colors}
                  onPress={
                    only
                      ? () => props.onOpenThread(only)
                      : machineId === null
                        ? null
                        : () => props.onSelectMachine(machineId)
                  }
                  opensThread={only != null}
                />
              );
            });
            return [
              <MachineNode
                key={"machine:" + (node.id ?? "more")}
                x={node.x}
                y={node.y}
                radius={machineRadius}
                machine={machine ?? null}
                aggregate={node.aggregate}
                connection={machine === undefined ? undefined : props.connections.get(machine.id)}
                selected={machineId !== null && machineId === props.selectedMachineId}
                colors={colors}
                onPress={machineId === null ? null : () => props.onSelectMachine(machineId)}
              />,
              ...agents,
            ];
          })}
        </>
      )}
    </View>
  );
}

const NO_WORK: Work = { running: 0, attention: 0, reported: 0 };

function MachineNode(props: {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly machine: FleetMachine | null;
  readonly aggregate: FleetAggregate | null;
  readonly connection: FleetConnection | undefined;
  readonly selected: boolean;
  readonly colors: Record<Tone, string>;
  readonly onPress: (() => void) | null;
}) {
  const { machine, radius } = props;
  const work: Work = machine ?? props.aggregate ?? NO_WORK;
  const tone = toneOf(work, machine?.answering ?? true);
  const label = machine?.label ?? plural(props.aggregate?.count ?? 0, "more machine");
  const status = machine === null ? null : (props.connection?.label ?? null);
  const accessibilityLabel = [label, status, describeWork(work)]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <Pressable
      accessibilityRole={props.onPress === null ? "text" : "button"}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={props.onPress === null ? undefined : "Shows only this machine's threads"}
      accessibilityState={{ selected: props.selected }}
      disabled={props.onPress === null}
      onPress={props.onPress ?? undefined}
      hitSlop={8}
      style={{
        position: "absolute",
        left: props.x - LABEL_WIDTH / 2,
        top: props.y - radius,
        width: LABEL_WIDTH,
        alignItems: "center",
      }}
    >
      <View
        className="items-center justify-center rounded-full bg-grouped-card"
        style={{
          width: radius * 2,
          height: radius * 2,
          borderWidth: props.selected ? 3 : 2,
          borderColor: props.colors[tone],
          borderStyle: tone === "away" ? "dashed" : "solid",
        }}
      >
        {machine === null ? (
          <Text className="text-xs font-goat-bold text-foreground" maxFontSizeMultiplier={1}>
            {"+" + (props.aggregate?.count ?? 0)}
          </Text>
        ) : (
          <EnvironmentMachineSymbol
            kind={machine.machineKind ?? (machine.kind === "cloud" ? "cloud" : "server")}
            size={radius}
            tintColorClassName={tone === "away" ? "accent-foreground-muted" : "accent-icon"}
          />
        )}
        {machine === null ? null : (
          <View style={{ position: "absolute", right: -6, bottom: -6 }}>
            <FleetMachineDot connection={props.connection} />
          </View>
        )}
      </View>
      <Text
        textRole="footnote"
        className={props.selected ? "font-goat-bold text-foreground" : "text-foreground-muted"}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={{ maxWidth: LABEL_WIDTH, marginTop: 2 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function AgentNode(props: {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly agent: FleetAgent | null;
  readonly aggregate: FleetAggregate | null;
  readonly machineLabel: string;
  readonly colors: Record<Tone, string>;
  readonly onPress: (() => void) | null;
  readonly opensThread: boolean;
}) {
  const work: Work = props.agent ?? props.aggregate ?? NO_WORK;
  const tone = toneOf(work, true);
  const name = props.agent?.label ?? plural(props.aggregate?.count ?? 0, "more agent");
  return (
    <Pressable
      accessibilityRole={props.onPress === null ? "text" : "button"}
      accessibilityLabel={name + " on " + props.machineLabel + ", " + describeWork(work)}
      accessibilityHint={
        props.onPress === null
          ? undefined
          : props.opensThread
            ? "Opens its thread"
            : "Shows only this machine's threads"
      }
      disabled={props.onPress === null}
      onPress={props.onPress ?? undefined}
      hitSlop={6}
      className="items-center justify-center rounded-full bg-grouped-card"
      style={{
        position: "absolute",
        left: props.x - props.radius,
        top: props.y - props.radius,
        width: props.radius * 2,
        height: props.radius * 2,
        borderWidth: 1.5,
        borderColor: props.colors[tone],
      }}
    >
      {props.agent?.driver ? (
        <ProviderIcon provider={props.agent.driver} size={Math.round(props.radius * 1.1)} />
      ) : (
        <Text className="text-2xs font-goat-bold text-foreground" maxFontSizeMultiplier={1}>
          {props.agent === null ? "+" + (props.aggregate?.count ?? 0) : "?"}
        </Text>
      )}
    </Pressable>
  );
}
