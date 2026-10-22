import type { FleetMachine, FleetSnapshot, FleetThread } from "@goat/client-runtime/state/fleet";
import {
  NO_FLEET_HEAT,
  type FleetHeatTier,
  type FleetMachineHeat,
} from "@goat/client-runtime/state/fleet-heat";
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { BoatIcon } from "../Icons";
import { GoatWordmark } from "../GoatWordmark";
import { renderProviderGlyph } from "../chat/ProviderInstanceIcon";
import { fleetMachineSubtitle } from "./describeMachine";
import {
  fleetConnectionVisual,
  UNKNOWN_FLEET_CONNECTION,
  type FleetConnection,
} from "./fleetConnection";
import { FleetConnectionGlyph } from "./FleetConnectionGlyph";
import { providerInstanceInitials } from "@goat/client-runtime/state/provider-instance-display";
import {
  rubberBand,
  stepSpring,
  ZERO_VECTOR,
  type FleetSpring,
  type FleetVector,
} from "./fleetDrag";
import {
  layoutFleet,
  orbitEdge,
  type FleetLayoutAgent,
  type FleetLayoutMachine,
  type FleetPoint,
} from "./fleetLayout";

/** Animated particles are capped; further running work still shows in the counts. */
const MAX_PARTICLES = 24;
const PARTICLE_SECONDS = 2.6;
/** How far a pulled node can travel from its orbit. */
const PULL_REACH = 110;
/** Agents trail their machine by this share of its pull. */
const AGENT_FOLLOW = 0.7;
/** A press that moves less than this is a click. */
const CLICK_SLOP = 4;
const MACHINE_RADIUS = 18;
const AGENT_RADIUS = 11;
/** The status mark sits on the machine's ring, lower right, like an avatar's presence dot. */
const STATUS_OFFSET = Math.round(MACHINE_RADIUS * Math.SQRT1_2);
const THIS_MACHINE = "This machine";

type HeatedTier = Exclude<FleetHeatTier, "normal">;

const HEAT_TINT: Record<HeatedTier, string> = {
  warm: "fill-heat-warm/15",
  hot: "fill-heat-hot/20",
  burning: "fill-heat-burning/25",
};
const HEAT_STROKE: Record<HeatedTier, string> = {
  warm: "stroke-heat-warm",
  hot: "stroke-heat-hot",
  burning: "stroke-heat-burning",
};

/** A unit flame, base at the origin, drawn 15 wide and 24 tall. */
const FLAME_PATH = "M0 0C-6.5 0-8-7-4.5-12.5C-3-15-1.5-18.5 0-24C2.5-18.5 7-14 7-8C7-3 4 0 0 0Z";
const FLAME_CORE_PATH =
  "M0 0C-3.5 0-4.5-4-2.5-7.5C-1.5-9.5-.5-11.5 0-14C1.5-11 4-8.5 4-5C4-2 2.2 0 0 0Z";
/**
 * Three flames rise behind the node's top, so its body hides their roots. They
 * flicker as one crown pivoting on CROWN_BASE: each running animation costs the
 * main thread a little every frame, so burning gets three (crown and two embers)
 * and every other tier none.
 */
const CROWN_BASE = -11;
const FLAMES = [
  { x: -8, y: 0, rotate: -24, scale: 0.62 },
  { x: 8.5, y: 0, rotate: 22, scale: 0.68 },
  { x: 0, y: -2, rotate: 0, scale: 1 },
] as const;
/** Embers start above the flames and drift up along their tilt. */
const EMBERS = [
  { x: -4.5, y: -30, size: 2.6, tilt: -8, delay: 0 },
  { x: 3.5, y: -33, size: 2.2, tilt: 10, delay: -1.2 },
] as const;

interface HeatPaint {
  readonly flame: string;
  readonly core: string;
}

/** Gradient ids for the flames; colors come from the --heat-* theme tokens. */
function useHeatPaint(): HeatPaint {
  const base = "fleet-heat-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return { flame: base + "-flame", core: base + "-core" };
}

/**
 * Flat oklch and oklab fills (including Tailwind's `fill-info/10`) drop a channel while a
 * shape is CSS-animated in Chromium, so a busy halo leaves yellow specks. A gradient fill
 * does not.
 */
function HaloDefs(props: { readonly info: string; readonly primary: string }) {
  return (
    <defs>
      <radialGradient id={props.info}>
        <stop offset="0" style={{ stopColor: "var(--info)", stopOpacity: 0.1 }} />
        <stop offset="1" style={{ stopColor: "var(--info)", stopOpacity: 0.1 }} />
      </radialGradient>
      <radialGradient id={props.primary}>
        <stop offset="0" style={{ stopColor: "var(--primary)", stopOpacity: 0.1 }} />
        <stop offset="1" style={{ stopColor: "var(--primary)", stopOpacity: 0.1 }} />
      </radialGradient>
    </defs>
  );
}

function HeatDefs({ paint }: { readonly paint: HeatPaint }) {
  return (
    <defs>
      <linearGradient id={paint.flame} x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" style={{ stopColor: "var(--heat-burning)", stopOpacity: 0.95 }} />
        <stop offset="0.55" style={{ stopColor: "var(--heat-hot)", stopOpacity: 0.85 }} />
        <stop offset="1" style={{ stopColor: "var(--heat-ember)", stopOpacity: 0.2 }} />
      </linearGradient>
      <linearGradient id={paint.core} x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" style={{ stopColor: "var(--heat-ember)", stopOpacity: 0.9 }} />
        <stop offset="1" style={{ stopColor: "var(--heat-ember)", stopOpacity: 0.35 }} />
      </linearGradient>
    </defs>
  );
}

interface HeatSpot {
  readonly id: string;
  readonly at: FleetPoint;
  readonly tier: "hot" | "burning";
}

/**
 * The glow, flames, and embers of hot and burning machines, as HTML behind the
 * graph. Chromium runs transform and opacity animations of HTML boxes on the
 * compositor, while every animated SVG shape costs a style pass each frame, so
 * the fire costs the main thread nothing once it starts.
 */
function HeatLayer(props: { readonly spots: ReadonlyArray<HeatSpot>; readonly paint: HeatPaint }) {
  const { spots, paint } = props;
  return (
    <div
      aria-hidden
      className="fleet-heat-layer pointer-events-none absolute inset-0 overflow-hidden"
    >
      {spots.map((spot) => (
        <div
          key={spot.id}
          data-tier={spot.tier}
          className="fleet-heat"
          style={{ transform: "translate(" + spot.at.x + "px, " + spot.at.y + "px)" }}
        >
          <div className="fleet-heat-glow" />
          {spot.tier === "burning" ? (
            <>
              <div
                className="fleet-heat-spot"
                style={{ transform: "translateY(" + CROWN_BASE + "px)" }}
              >
                <div className="fleet-flames">
                  {FLAMES.map((flame) => (
                    <svg
                      key={flame.x}
                      viewBox="-7.5 -24 15 24"
                      className="fleet-flame"
                      style={{
                        transform:
                          "translate(" +
                          flame.x +
                          "px, " +
                          flame.y +
                          "px) rotate(" +
                          flame.rotate +
                          "deg) scale(" +
                          flame.scale +
                          ")",
                      }}
                    >
                      <path d={FLAME_PATH} fill={"url(#" + paint.flame + ")"} />
                      <path d={FLAME_CORE_PATH} fill={"url(#" + paint.core + ")"} />
                    </svg>
                  ))}
                </div>
              </div>
              {EMBERS.map((ember) => (
                <div
                  key={ember.x}
                  className="fleet-heat-spot"
                  style={{
                    transform:
                      "translate(" +
                      ember.x +
                      "px, " +
                      ember.y +
                      "px) rotate(" +
                      ember.tilt +
                      "deg)",
                  }}
                >
                  <span
                    className="fleet-ember"
                    style={{
                      width: ember.size,
                      height: ember.size,
                      animationDelay: ember.delay + "s",
                    }}
                  />
                </div>
              ))}
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return observeResize(element, (entries) => {
      setWidth(Math.round(entries.at(-1)!.contentRect.width));
    });
  }, []);
  return [ref, width] as const;
}

/** Pauses SMIL and CSS animation while the tab is hidden, without re-rendering. */
function usePauseWhileHidden(svg: React.RefObject<SVGSVGElement | null>) {
  useEffect(() => {
    const sync = () => {
      const element = svg.current;
      if (element === null) return;
      if (document.hidden) element.pauseAnimations();
      else element.unpauseAnimations();
      element.toggleAttribute("data-paused", document.hidden);
      // The heat layer is HTML beside the SVG, so it pauses from the wrapper.
      element.parentElement?.toggleAttribute("data-paused", document.hidden);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [svg]);
}

type Offsets = ReadonlyMap<string, FleetVector>;

/**
 * Lets the user pull machine and agent nodes around. A node follows the pointer with
 * rubber-band resistance and springs back to its orbit on release. Frames are drawn
 * only while something is held or settling.
 */
function usePullableNodes(
  svg: React.RefObject<SVGSVGElement | null>,
  width: number,
  reduced: boolean,
) {
  const [offsets, setOffsets] = useState<Offsets>(() => new Map());
  const held = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    base: FleetVector;
    moved: boolean;
  } | null>(null);
  const springs = useRef(new Map<string, FleetSpring>());
  const frame = useRef<number | null>(null);
  const lastTick = useRef(0);

  const tick = function tick(now: number) {
    const seconds = lastTick.current === 0 ? 1 / 60 : (now - lastTick.current) / 1000;
    lastTick.current = now;
    const next = new Map<string, FleetVector>();
    for (const [key, spring] of springs.current) {
      const stepped = stepSpring(spring, seconds);
      if (stepped === null) springs.current.delete(key);
      else {
        springs.current.set(key, stepped);
        next.set(key, stepped.offset);
      }
    }
    setOffsets((current) => {
      const merged = new Map(current);
      for (const key of current.keys()) {
        if (key !== held.current?.key && !next.has(key)) merged.delete(key);
      }
      for (const [key, offset] of next) merged.set(key, offset);
      return merged;
    });
    frame.current = springs.current.size > 0 ? requestAnimationFrame(tick) : null;
    if (frame.current === null) lastTick.current = 0;
  };

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const press = (key: string, event: PointerEvent<SVGGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    springs.current.delete(key);
    held.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: offsets.get(key) ?? ZERO_VECTOR,
      moved: false,
    };
  };

  const move = (event: PointerEvent<SVGGElement>) => {
    const current = held.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const rect = svg.current?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? width / rect.width : 1;
    const dx = (event.clientX - current.startX) * scale;
    const dy = (event.clientY - current.startY) * scale;
    if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    current.moved = true;
    const offset = rubberBand({ x: current.base.x + dx, y: current.base.y + dy }, PULL_REACH);
    setOffsets((previous) => new Map(previous).set(current.key, offset));
  };

  /** Returns whether the press was a click rather than a pull. */
  const release = (event: PointerEvent<SVGGElement>): boolean => {
    const current = held.current;
    if (current === null || current.pointerId !== event.pointerId) return false;
    held.current = null;
    if (!current.moved) return true;
    const offset = offsets.get(current.key) ?? ZERO_VECTOR;
    if (reduced) {
      setOffsets((previous) => {
        const next = new Map(previous);
        next.delete(current.key);
        return next;
      });
      return false;
    }
    springs.current.set(current.key, { offset, velocity: ZERO_VECTOR });
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
    return false;
  };

  return { offsets, press, move, release };
}

const add = (point: FleetPoint, offset: FleetVector | undefined, share = 1): FleetPoint =>
  offset === undefined ? point : { x: point.x + offset.x * share, y: point.y + offset.y * share };

const truncate = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;

function workSummary(work: { running: number; attention: number; reported: number }): string {
  const parts = [
    work.running > 0 ? work.running + " running" : null,
    work.attention > 0 ? work.attention + " need you" : null,
    work.reported > 0 ? work.reported + " reported" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "idle" : parts.join(", ");
}

const machineKey = (machineId: string) => "machine\u0000" + machineId;
const agentKey = (machineId: string, agent: string) => "agent\u0000" + machineId + "\u0000" + agent;

interface PlacedAgent {
  readonly key: string;
  readonly layout: FleetLayoutAgent;
  readonly at: FleetPoint;
}

interface PlacedMachine {
  readonly layout: FleetLayoutMachine;
  readonly at: FleetPoint;
  readonly edge: string;
  readonly agents: ReadonlyArray<PlacedAgent>;
}

export const FleetGraph = memo(function FleetGraph(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly currentMachineId: string | null;
  readonly selectedMachineId: string | null;
  readonly onSelectMachine: (machineId: string) => void;
  /** How hard each machine is working, by machine id; absent draws every node normal. */
  readonly heat?: ReadonlyMap<string, FleetMachineHeat>;
  /** Connection attempts that have run long: their edges stop moving and say so. */
  readonly slowMachineIds?: ReadonlySet<string>;
}) {
  const { snapshot, connections, currentMachineId, selectedMachineId, onSelectMachine, heat } =
    props;
  const slow = props.slowMachineIds;
  const [wrapperRef, width] = useElementWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const paint = useHeatPaint();
  const haloBase = "fleet-halo-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const infoHalo = haloBase + "-info";
  const primaryHalo = haloBase + "-primary";
  usePauseWhileHidden(svgRef);
  const { offsets, press, move, release } = usePullableNodes(svgRef, width, reduced);
  // Below 340 the orbits cannot keep labels apart; see ORBIT_GAP in fleetLayout.
  const height = width < 640 ? 360 : Math.max(340, Math.min(420, Math.round(width * 0.42)));
  const layout = width > 0 ? layoutFleet(snapshot.machines, width, height) : null;
  const machinesById = new Map(snapshot.machines.map((machine) => [machine.id, machine]));
  // Where every node is drawn this frame: its orbit spot plus any pull.
  const placed =
    layout === null
      ? []
      : layout.machines.map((node): PlacedMachine => {
          const id = node.id ?? "more";
          const machineOffset = offsets.get(machineKey(id));
          const at = add(node, machineOffset);
          return {
            layout: node,
            at,
            edge: machineOffset === undefined ? node.edge : orbitEdge(layout.center, at),
            agents: node.agents.map((agentNode) => {
              const key = agentKey(id, agentNode.key);
              return {
                key,
                layout: agentNode,
                at: add(add(agentNode, machineOffset, AGENT_FOLLOW), offsets.get(key)),
              };
            }),
          };
        });
  const placedById = new Map(
    placed.flatMap((entry) =>
      entry.layout.id === null ? [] : [[entry.layout.id, entry] as const],
    ),
  );
  const live = snapshot.totals.running + snapshot.totals.attention;
  const heatSpots = reduced
    ? []
    : placed.flatMap((entry): HeatSpot[] => {
        const tier = entry.layout.id === null ? null : heat?.get(entry.layout.id)?.tier;
        return tier === "hot" || tier === "burning"
          ? [{ id: entry.layout.id!, at: entry.at, tier }]
          : [];
      });

  const nodeHandlers = (key: string, onClick?: () => void) => ({
    onPointerDown: (event: PointerEvent<SVGGElement>) => press(key, event),
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<SVGGElement>) => {
      if (release(event)) onClick?.();
    },
    onPointerCancel: (event: PointerEvent<SVGGElement>) => {
      release(event);
    },
  });

  return (
    <div ref={wrapperRef} className="fleet-graph relative w-full">
      {layout === null ? (
        <div style={{ height }} />
      ) : (
        <>
          {heatSpots.length > 0 ? <HeatLayer spots={heatSpots} paint={paint} /> : null}
          <svg
            ref={svgRef}
            viewBox={"0 0 " + width + " " + height}
            className="relative block h-auto w-full select-none"
            role="group"
            aria-label={
              snapshot.totals.machines +
              " machines, " +
              snapshot.totals.running +
              " running, " +
              snapshot.totals.attention +
              " need you"
            }
          >
            <HeatDefs paint={paint} />
            <HaloDefs info={infoHalo} primary={primaryHalo} />
            <ellipse
              cx={layout.center.x}
              cy={layout.center.y}
              rx={layout.inner.rx}
              ry={layout.inner.ry}
              fill="none"
              className={cn("stroke-border", !reduced && "fleet-orbit")}
              strokeDasharray="2 6"
            />
            <ellipse
              cx={layout.center.x}
              cy={layout.center.y}
              rx={layout.outer.rx}
              ry={layout.outer.ry}
              fill="none"
              className={cn("stroke-border/60", !reduced && "fleet-orbit fleet-orbit-reverse")}
              strokeDasharray="1 9"
            />

            {placed.map((entry) => {
              const machine = entry.layout.id === null ? null : machinesById.get(entry.layout.id)!;
              const work = machine ?? entry.layout.aggregate!;
              const busy = work.running + work.attention > 0;
              const link =
                machine === null
                  ? null
                  : fleetConnectionVisual(
                      (connections.get(machine.id) ?? UNKNOWN_FLEET_CONNECTION).state,
                    ).edge;
              return (
                <g key={"edge:" + (entry.layout.id ?? "more")}>
                  {link === null ? (
                    <path
                      d={entry.edge}
                      fill="none"
                      className={busy ? "stroke-info/40" : "stroke-border"}
                      strokeWidth={busy ? 1.6 : 1.2}
                      strokeDasharray={machine?.kind === "environment" || busy ? undefined : "3 5"}
                    />
                  ) : (
                    <path
                      d={entry.edge}
                      fill="none"
                      className={cn(
                        link.className,
                        link.animated && !reduced && !slow?.has(machine!.id) && "fleet-flow",
                      )}
                      strokeWidth={1.4}
                      strokeDasharray={link.dash}
                    />
                  )}
                  {busy && !reduced ? (
                    <path
                      d={entry.edge}
                      fill="none"
                      className="fleet-flow stroke-info"
                      strokeWidth={1.6}
                      strokeDasharray="2 12"
                    />
                  ) : null}
                  {entry.agents.map((agent) => {
                    const data = machine?.agents.find((item) => item.key === agent.layout.key);
                    const agentWork = data ?? agent.layout.aggregate!;
                    const agentBusy = agentWork.running + agentWork.attention > 0;
                    return (
                      <line
                        key={"link:" + agent.key}
                        x1={entry.at.x}
                        y1={entry.at.y}
                        x2={agent.at.x}
                        y2={agent.at.y}
                        className={agentBusy ? "stroke-info/60" : "stroke-border"}
                        strokeDasharray={agentBusy ? undefined : "2 4"}
                      />
                    );
                  })}
                </g>
              );
            })}

            {reduced
              ? null
              : snapshot.threads
                  .filter((thread) => thread.state === "running")
                  .slice(0, MAX_PARTICLES)
                  .map((thread, index) => (
                    <Particle
                      key={thread.key}
                      thread={thread}
                      index={index}
                      entry={placedById.get(thread.machineId)}
                    />
                  ))}

            {placed.flatMap((entry) =>
              entry.agents.map((agent) => {
                const machine =
                  entry.layout.id === null ? undefined : machinesById.get(entry.layout.id);
                const data = machine?.agents.find((item) => item.key === agent.layout.key);
                const work = data ?? agent.layout.aggregate!;
                const label = data ? data.label : agent.layout.aggregate!.count + " more";
                const labelY = agent.layout.labelBelow ? AGENT_RADIUS + 13 : -(AGENT_RADIUS + 7);
                return (
                  <g
                    key={agent.key}
                    transform={"translate(" + agent.at.x + " " + agent.at.y + ")"}
                    className="cursor-grab touch-none active:cursor-grabbing"
                    {...nodeHandlers(agent.key)}
                  >
                    <title>{label + " · " + workSummary(work)}</title>
                    {work.attention > 0 ? (
                      <circle
                        r={AGENT_RADIUS + 6}
                        fill="none"
                        className={cn("stroke-warning", !reduced && "fleet-ring")}
                        strokeWidth={1.5}
                      />
                    ) : null}
                    <circle
                      r={AGENT_RADIUS}
                      className={cn(
                        "fill-background",
                        work.attention > 0
                          ? "stroke-warning"
                          : work.running > 0
                            ? "stroke-info"
                            : "stroke-muted-foreground",
                      )}
                      strokeWidth={1.4}
                      strokeDasharray={
                        work.reported > 0 && work.running + work.attention === 0 ? "2 3" : undefined
                      }
                    />
                    {(data?.driver
                      ? renderProviderGlyph({ driverKind: data.driver, x: -7, y: -7, size: 14 })
                      : null) ?? (
                      <text
                        y={3.5}
                        textAnchor="middle"
                        className="fill-foreground text-4xs font-semibold"
                      >
                        {data
                          ? data.driver
                            ? providerInstanceInitials(data.label)
                            : "?"
                          : "+" + agent.layout.aggregate!.count}
                      </text>
                    )}
                    <text y={labelY} textAnchor="middle" className="fill-muted-foreground text-4xs">
                      {truncate(label, 18)}
                    </text>
                  </g>
                );
              }),
            )}

            {placed.map((entry) =>
              entry.layout.id === null ? (
                <AggregateNode
                  key="machine:more"
                  at={entry.at}
                  node={entry.layout}
                  handlers={nodeHandlers(machineKey("more"))}
                />
              ) : (
                <MachineNode
                  key={"machine:" + entry.layout.id}
                  at={entry.at}
                  halo={infoHalo}
                  machine={machinesById.get(entry.layout.id)!}
                  connection={connections.get(entry.layout.id) ?? UNKNOWN_FLEET_CONNECTION}
                  slow={slow?.has(entry.layout.id) === true}
                  heat={heat?.get(entry.layout.id) ?? NO_FLEET_HEAT}
                  current={currentMachineId === entry.layout.id}
                  selected={selectedMachineId === entry.layout.id}
                  reduced={reduced}
                  onSelect={onSelectMachine}
                  handlers={nodeHandlers(machineKey(entry.layout.id), () =>
                    onSelectMachine(entry.layout.id!),
                  )}
                />
              ),
            )}

            <g transform={"translate(" + layout.center.x + " " + layout.center.y + ")"}>
              {live > 0 && !reduced ? (
                <circle r={36} className="fleet-breathe" fill={"url(#" + primaryHalo + ")"} />
              ) : null}
              <circle
                r={29}
                fill="none"
                className={cn("stroke-primary/50", !reduced && "fleet-spin")}
                strokeDasharray="3 7"
              />
              <circle r={22} className="fill-primary" />
              <GoatWordmark
                x={-12}
                y={-12}
                width={24}
                height={24}
                role="img"
                aria-label="GOAT"
                className="text-primary-foreground"
              />
            </g>
          </svg>
        </>
      )}
    </div>
  );
});

function Particle(props: {
  readonly thread: FleetThread;
  readonly index: number;
  readonly entry: PlacedMachine | undefined;
}) {
  const { entry, index, thread } = props;
  if (entry === undefined) return null;
  const agent = entry.agents.find((item) => item.layout.key === thread.agentKey);
  const path = entry.edge + (agent ? " L" + agent.at.x + " " + agent.at.y : "");
  return (
    <g className="pointer-events-none">
      {[0, 1, 2].map((step) => (
        <circle
          key={step}
          r={step === 0 ? 3.5 : 2.2}
          className="fill-info"
          opacity={step === 0 ? 1 : 0.5}
        >
          <animateMotion
            dur={PARTICLE_SECONDS + "s"}
            begin={-((index * 0.37 + step * (PARTICLE_SECONDS / 3)) % PARTICLE_SECONDS) + "s"}
            repeatCount="indefinite"
            path={path}
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="spline"
            keySplines="0.45 0 0.35 1"
          />
        </circle>
      ))}
    </g>
  );
}

type NodeHandlers = {
  readonly onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  readonly onPointerMove: (event: PointerEvent<SVGGElement>) => void;
  readonly onPointerUp: (event: PointerEvent<SVGGElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<SVGGElement>) => void;
};

function MachineNode(props: {
  readonly at: FleetPoint;
  /** Gradient id for the busy halo. A flat oklab fill speckles while the halo breathes. */
  readonly halo: string;
  readonly machine: FleetMachine;
  readonly connection: FleetConnection;
  /** The connection attempt has run long. */
  readonly slow: boolean;
  readonly heat: FleetMachineHeat;
  /** The machine this app runs on. */
  readonly current: boolean;
  readonly selected: boolean;
  readonly reduced: boolean;
  readonly onSelect: (machineId: string) => void;
  readonly handlers: NodeHandlers;
}) {
  const { at, machine, connection, heat, current, selected, reduced, onSelect, handlers } = props;
  const busy = machine.running + machine.attention;
  const { quiet } = fleetConnectionVisual(connection.state);
  const heated = heat.tier === "normal" ? null : heat.tier;
  // The heat layer's glow replaces the busy halo.
  const glowing = (heated === "hot" || heated === "burning") && !reduced;
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(machine.id);
  };
  // The user knows their own hardware; naming the machine is what matters here.
  const sub = current
    ? THIS_MACHINE
    : (fleetMachineSubtitle(machine) ??
      (machine.kind === "environment" ? null : machine.kind === "cloud" ? "cloud" : "ssh"));
  const status =
    connection.state === "unknown"
      ? []
      : [
          (props.slow ? "Still connecting" : connection.label) +
            (connection.reason === null ? "" : ": " + connection.reason),
        ];
  const description = [
    current ? THIS_MACHINE : null,
    machine.boat === null ? null : "Boat machine",
    ...status,
    workSummary(machine),
  ].filter((part) => part !== null);
  // Only heat is worth announcing; a normal reading stays in the tooltip.
  const spoken =
    heated === null ? description : [...description, heat.summary.replaceAll(" · ", ", ")];
  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={[machine.label, ...spoken].join(", ")}
      data-heat={heat.tier}
      className="fleet-node cursor-grab touch-none outline-none active:cursor-grabbing"
      onKeyDown={onKeyDown}
      transform={"translate(" + at.x + " " + at.y + ")"}
      {...handlers}
    >
      <title>{[machine.label, ...description, heat.summary].join("\n")}</title>
      {busy > 0 && !reduced && !glowing ? (
        <circle
          r={MACHINE_RADIUS + 8}
          className="fleet-breathe"
          fill={"url(#" + props.halo + ")"}
        />
      ) : null}
      {current ? (
        <circle r={MACHINE_RADIUS + 4} fill="none" className="stroke-foreground/25" />
      ) : null}
      <circle
        r={MACHINE_RADIUS}
        className={cn(
          "fleet-node-ring fill-background",
          selected
            ? "stroke-primary"
            : machine.attention > 0
              ? "stroke-warning"
              : heated !== null
                ? HEAT_STROKE[heated]
                : busy > 0
                  ? "stroke-info"
                  : quiet
                    ? "stroke-muted-foreground/30"
                    : "stroke-muted-foreground/60",
        )}
        strokeWidth={selected ? 2.4 : 1.6}
      />
      {heated === null ? null : (
        <circle r={MACHINE_RADIUS - 0.8} className={cn("pointer-events-none", HEAT_TINT[heated])} />
      )}
      {machine.boat !== null ? (
        <BoatIcon
          data-fleet-boat-logo=""
          x={-8}
          y={-8}
          width={16}
          height={16}
          className={quiet ? "opacity-55" : undefined}
        />
      ) : (
        <EnvironmentMachineIcon
          kind={machine.machineKind ?? (machine.kind === "cloud" ? "cloud" : "server")}
          x={-8}
          y={-8}
          width={16}
          height={16}
          className={quiet ? "text-muted-foreground/70" : "text-foreground"}
        />
      )}
      <g transform={"translate(" + STATUS_OFFSET + " " + STATUS_OFFSET + ")"}>
        <FleetConnectionGlyph state={connection.state} halo />
      </g>
      {busy > 0 ? (
        <g transform="translate(13 -13)">
          <circle r={7} className={machine.attention > 0 ? "fill-warning" : "fill-info"} />
          <text y={3} textAnchor="middle" className="fill-background text-4xs font-bold">
            {busy > 99 ? "99+" : busy}
          </text>
        </g>
      ) : machine.reported > 0 ? (
        <g transform="translate(13 -13)">
          <circle r={7} className="fill-background stroke-muted-foreground" strokeDasharray="2 2" />
          <text y={3} textAnchor="middle" className="fill-muted-foreground text-4xs font-bold">
            {machine.reported > 99 ? "99+" : machine.reported}
          </text>
        </g>
      ) : null}
      <text
        y={MACHINE_RADIUS + 13}
        textAnchor="middle"
        className={cn("text-3xs font-medium", quiet ? "fill-muted-foreground" : "fill-foreground")}
      >
        {truncate(machine.label, 18)}
      </text>
      {sub === null ? null : (
        <text
          y={MACHINE_RADIUS + 24}
          textAnchor="middle"
          className="fill-muted-foreground text-4xs"
        >
          {truncate(sub, 22)}
        </text>
      )}
    </g>
  );
}

function AggregateNode(props: {
  readonly at: FleetPoint;
  readonly node: FleetLayoutMachine;
  readonly handlers: NodeHandlers;
}) {
  const work = props.node.aggregate!;
  return (
    <g
      transform={"translate(" + props.at.x + " " + props.at.y + ")"}
      className="cursor-grab touch-none active:cursor-grabbing"
      {...props.handlers}
    >
      <title>{work.count + " more machines · " + workSummary(work)}</title>
      <circle
        r={MACHINE_RADIUS}
        className="fill-background stroke-muted-foreground/60"
        strokeWidth={1.6}
        strokeDasharray="3 3"
      />
      <text y={3.5} textAnchor="middle" className="fill-foreground text-3xs font-semibold">
        {"+" + work.count}
      </text>
      <text y={MACHINE_RADIUS + 13} textAnchor="middle" className="fill-muted-foreground text-4xs">
        {workSummary(work)}
      </text>
    </g>
  );
}
