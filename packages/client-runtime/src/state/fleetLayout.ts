/**
 * Orbit layout for the fleet graph: Main in the center, machines on an inner
 * orbit, the providers working on each machine on an outer orbit.
 *
 * Large fleets fold into aggregate nodes so the graph stays legible and every
 * thread still counts somewhere on it.
 */

export const MAX_GRAPH_MACHINES = 12;
export const MAX_GRAPH_AGENTS = 6;
/** Phones and tablets: at these caps no two nodes touch at any width from 320 up. */
export const COMPACT_GRAPH_LIMITS = { machines: 6, agents: 3 } as const;

/** Node radii and touch margins for the compact graph; touch targets of neighbors never overlap. */
export const COMPACT_GRAPH_NODES = {
  machineRadius: 16,
  machineHitSlop: 2,
  agentRadius: 10,
  agentHitSlop: 2,
} as const;

/** The compact graph's height for a width: taller on tablets, never too short for the orbit gap. */
export function compactGraphHeight(width: number): number {
  return width >= 600 ? 420 : Math.min(380, Math.max(300, Math.round(width * 0.9)));
}
/**
 * Vertical room between the orbits: a machine's radius and two label lines plus an
 * agent's radius and attention ring, so a node directly above or below never collides.
 */
const ORBIT_GAP = 72;

export interface FleetWork {
  readonly running: number;
  readonly attention: number;
  readonly reported: number;
}

export interface LayoutMachineInput extends FleetWork {
  readonly id: string;
  readonly agents: ReadonlyArray<FleetWork & { readonly key: string }>;
}

export interface FleetAggregate extends FleetWork {
  /** How many machines or agents this node stands for. */
  readonly count: number;
}

export interface FleetPoint {
  readonly x: number;
  readonly y: number;
}

export interface FleetLayoutAgent extends FleetPoint {
  readonly key: string;
  readonly labelBelow: boolean;
  readonly aggregate: FleetAggregate | null;
}

export interface FleetLayoutMachine extends FleetPoint {
  /** A machine id, or null for the "+N machines" node. */
  readonly id: string | null;
  readonly angle: number;
  /** Curved path from Main to the machine. */
  readonly edge: string;
  readonly aggregate: FleetAggregate | null;
  readonly agents: ReadonlyArray<FleetLayoutAgent>;
}

export interface FleetLayout {
  readonly center: FleetPoint;
  readonly inner: { readonly rx: number; readonly ry: number };
  readonly outer: { readonly rx: number; readonly ry: number };
  readonly machines: ReadonlyArray<FleetLayoutMachine>;
}

const isBusy = (work: FleetWork) => work.running + work.attention + work.reported > 0;

function aggregate(items: ReadonlyArray<FleetWork>): FleetAggregate {
  return {
    count: items.length,
    running: items.reduce((sum, item) => sum + item.running, 0),
    attention: items.reduce((sum, item) => sum + item.attention, 0),
    reported: items.reduce((sum, item) => sum + item.reported, 0),
  };
}

/** Keeps busy entries ahead of idle ones when some must fold, preserving order otherwise. */
function fold<T extends FleetWork>(
  items: ReadonlyArray<T>,
  limit: number,
): { readonly shown: ReadonlyArray<T>; readonly folded: FleetAggregate | null } {
  if (items.length <= limit) return { shown: items, folded: null };
  const ranked = [...items.filter(isBusy), ...items.filter((item) => !isBusy(item))];
  return { shown: ranked.slice(0, limit - 1), folded: aggregate(ranked.slice(limit - 1)) };
}

function machineAngles(count: number, narrow: boolean): number[] {
  if (count === 1) return [0];
  if (count === 2) return narrow ? [-Math.PI / 2, Math.PI / 2] : [Math.PI, 0];
  // On narrow screens a quarter-step offset keeps two labels from sharing a height.
  return Array.from(
    { length: count },
    (_, index) => -Math.PI / 2 + ((index + (narrow ? 0.25 : 0.5)) * 2 * Math.PI) / count,
  );
}

const round = (value: number) => Math.round(value * 10) / 10;

/** A gentle curve from Main to a machine, as an SVG path. */
export function orbitEdge(center: FleetPoint, point: FleetPoint): string {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = 0.18 * length;
  const cx = round((center.x + point.x) / 2 - (dy / length) * bend);
  const cy = round((center.y + point.y) / 2 + (dx / length) * bend);
  return (
    "M" +
    center.x +
    " " +
    center.y +
    " Q" +
    cx +
    " " +
    cy +
    " " +
    round(point.x) +
    " " +
    round(point.y)
  );
}

export function layoutFleet(
  machines: ReadonlyArray<LayoutMachineInput>,
  width: number,
  height: number,
  /** Fewer nodes for small screens; what does not fit folds into "+N" nodes. */
  limits: { readonly machines: number; readonly agents: number } = {
    machines: MAX_GRAPH_MACHINES,
    agents: MAX_GRAPH_AGENTS,
  },
): FleetLayout {
  const center = { x: width / 2, y: height / 2 };
  const narrow = width < 640;
  const outer = narrow
    ? { rx: width / 2 - 42, ry: height / 2 - 40 }
    : { rx: width / 2 - 70, ry: height / 2 - 40 };
  const inner = {
    rx: width * (narrow ? 0.17 : 0.25),
    ry: Math.min(height * 0.22, outer.ry - ORBIT_GAP),
  };
  const { shown, folded } = fold(machines, limits.machines);
  const nodes: ReadonlyArray<LayoutMachineInput | null> = folded ? [...shown, null] : shown;
  const angles = machineAngles(nodes.length, narrow);

  return {
    center,
    inner,
    outer,
    machines: nodes.map((machine, index): FleetLayoutMachine => {
      const angle = angles[index] ?? 0;
      const x = round(center.x + inner.rx * Math.cos(angle));
      const y = round(center.y + inner.ry * Math.sin(angle));
      const edge = orbitEdge(center, { x, y });
      if (machine === null) {
        return { id: null, x, y, angle, edge, aggregate: folded, agents: [] };
      }
      const agentFold = fold(machine.agents, limits.agents);
      const agentNodes = agentFold.folded
        ? [
            ...agentFold.shown.map((agent) => ({ key: agent.key, aggregate: null })),
            {
              key: machine.id + ":more",
              aggregate: agentFold.folded,
            },
          ]
        : agentFold.shown.map((agent) => ({ key: agent.key, aggregate: null }));
      const spread = Math.min(0.42, (2 * Math.PI) / nodes.length / (agentNodes.length + 0.6));
      return {
        id: machine.id,
        x,
        y,
        angle,
        edge,
        aggregate: null,
        agents: agentNodes.map((agent, agentIndex) => {
          const agentAngle = angle + (agentIndex - (agentNodes.length - 1) / 2) * spread;
          const ay = round(center.y + outer.ry * Math.sin(agentAngle));
          return {
            key: agent.key,
            aggregate: agent.aggregate,
            x: round(center.x + outer.rx * Math.cos(agentAngle)),
            y: ay,
            labelBelow: ay >= center.y - 4,
          };
        }),
      };
    }),
  };
}
