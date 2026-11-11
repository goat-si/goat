/**
 * Orbit layout for the fleet graph: Main in the center, machines on an inner orbit (staggered
 * bands of it past twelve), the providers working on each machine on an outer orbit. Beyond the
 * caps the rest fold into aggregate nodes, so every thread still counts somewhere on it.
 */

export const MAX_GRAPH_MACHINES = 40;
export const MAX_GRAPH_AGENTS = 6;
/** Up to this many machines share one orbit in the full graph. */
const ORBIT_MACHINES = 12;
/**
 * Nodes of a full graph past twelve machines: a machine's reach covers its work badge, its name
 * and subtitle, cut to the layout's labelChars, fit labelWidth below it, and an agent has one label line.
 */
export const DENSE_GRAPH_NODES = {
  machineReach: 22,
  labelTop: 20,
  labelBottom: 46,
  labelWidth: 84,
  agentReach: 17,
  agentLabelWidth: 62,
  agentLabelHeight: 10,
} as const;
/**
 * Node radii, touch margins and the one-line label box below each machine in the compact graph.
 * At the caps compactGraphLimits gives, no two of these boxes overlap.
 */
export const COMPACT_GRAPH_NODES = {
  machineRadius: 16,
  machineHitSlop: 2,
  agentRadius: 10,
  agentHitSlop: 2,
  labelWidth: 72,
  labelHeight: 22,
} as const;

/** The compact graph's height for a width: taller than wide on phones, so labels have room. */
export function compactGraphHeight(width: number): number {
  return width >= 600 ? 420 : Math.min(440, Math.max(300, Math.round(width * 1.1)));
}

/** Phones and tablets: below 390 pt five machines fit with their labels, above it six. */
export function compactGraphLimits(width: number) {
  return { machines: width < 390 ? 5 : 6, agents: 3, compact: true } as const;
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
  /** How many characters a machine's name and subtitle, and an agent's name, show before a cut. */
  readonly labelChars: { readonly name: number; readonly subtitle: number; readonly agent: number };
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

/** Distance from the graph's side to the agent orbit, and from its top to the agents' labels. */
const EDGE = { x: 70, y: 40 };
/** The hub's breathing halo. */
const HUB_REACH = 36;
/**
 * Distance from the outermost band to the agent orbit, along both axes: enough that a machine's
 * label and an agent with its label stay apart on a diagonal too, where both gaps shrink.
 */
const DENSE_ORBIT_GAP = 96;

interface MachineBands {
  readonly count: number;
  /** Places around the orbit, a whole number of band cycles so the seam keeps bands alternating. */
  readonly slots: number;
  /** The innermost band; each further band sits one step out. */
  readonly rx: number;
  readonly ry: number;
  readonly step: FleetPoint;
  readonly width: number;
  readonly height: number;
}

/** The smallest ry for which an ellipse of this rx encloses every corner. */
function enclosingRy(rx: number, corners: ReadonlyArray<FleetPoint>): number {
  return Math.max(...corners.map((corner) => corner.y / Math.sqrt(1 - (corner.x / rx) ** 2)));
}

/**
 * Staggered bands for a dense graph. Neighbours around the orbit sit on different bands, so
 * only machines a full band cycle apart need a label's width between them. Picks the
 * shortest graph that fits the width, or else the narrowest one, which then scrolls.
 */
function machineBands(machines: number, width: number): MachineBands {
  const { machineReach: reach, labelWidth, labelTop, labelBottom } = DENSE_GRAPH_NODES;
  const label = labelWidth / 2;
  // Two machines collide when one sits inside this cross of the other: node on label, or label on label.
  const besideLabel = { x: 2 * label + 4, y: labelBottom - labelTop + 4 };
  const apart = [{ x: reach + label + 4, y: reach + labelBottom + 4 }, besideLabel];
  // No machine centre may enter this box around the hub, or its label would cross it.
  const hub = { x: HUB_REACH + label + 4, y: HUB_REACH + labelBottom + 4 };
  // Neighbours on adjacent bands are one step apart in some direction, so the step clears the cross.
  const stepX = 1.1 * besideLabel.x;
  const step = { x: stepX, y: enclosingRy(stepX, apart) };
  const margin = EDGE.x + DENSE_ORBIT_GAP;
  const candidates = [1, 2, 3, 4].map((count): MachineBands => {
    const slots = Math.ceil(machines / count) * count;
    // Machines one band cycle apart are this share of the radii from each other.
    const chord = 2 * Math.sin((count * Math.PI) / slots);
    const spread = (count - 1) * step.x;
    // The narrowest inner band; a wider card stretches every band to its width.
    const rx = Math.max(1.5 * hub.x, (1.05 * besideLabel.x) / chord);
    const needed = Math.ceil(2 * (rx + spread + margin));
    const wide = Math.max(rx, width / 2 - margin - spread);
    const ry = Math.max(enclosingRy(wide * chord, apart) / chord, enclosingRy(wide, [hub]));
    return {
      count,
      slots,
      rx: wide,
      ry,
      step,
      width: Math.max(width, needed),
      height: Math.ceil(2 * (ry + (count - 1) * step.y + DENSE_ORBIT_GAP + EDGE.y)),
    };
  });
  return candidates.reduce((best, candidate) =>
    (
      candidate.width === width
        ? best.width > width || candidate.height < best.height
        : candidate.width < best.width
    )
      ? candidate
      : best,
  );
}

/**
 * The full graph's size for its container's width. Up to twelve machines share one orbit and
 * the graph keeps the container's width; more machines make it taller, and wider (so its card
 * scrolls) only when the container cannot hold them.
 */
export function fleetGraphSize(machines: number, width: number): { width: number; height: number } {
  const shown = Math.min(machines, MAX_GRAPH_MACHINES);
  if (shown <= ORBIT_MACHINES) {
    // Below 340 the orbits cannot keep labels apart; see ORBIT_GAP.
    const height = width < 640 ? 360 : Math.max(340, Math.min(420, Math.round(width * 0.42)));
    return { width, height };
  }
  const bands = machineBands(shown, width);
  return { width: bands.width, height: bands.height };
}

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
  /**
   * Fewer nodes for small screens; what does not fit folds into "+N" nodes. Compact orbits sit
   * wider and closer to the edge, leaving room for a label under every machine on a phone.
   */
  limits: {
    readonly machines: number;
    readonly agents: number;
    readonly compact?: boolean;
  } = {
    machines: MAX_GRAPH_MACHINES,
    agents: MAX_GRAPH_AGENTS,
  },
): FleetLayout {
  const center = { x: width / 2, y: height / 2 };
  const compact = limits.compact === true;
  const { shown, folded } = fold(machines, limits.machines);
  const nodes: ReadonlyArray<LayoutMachineInput | null> = folded ? [...shown, null] : shown;
  const bands =
    !compact && nodes.length > ORBIT_MACHINES ? machineBands(nodes.length, width) : null;
  const narrow = compact || (width < 640 && bands === null);
  const outer = compact
    ? { rx: width / 2 - 16, ry: height / 2 - 16 }
    : narrow
      ? { rx: width / 2 - 42, ry: height / 2 - 40 }
      : { rx: width / 2 - EDGE.x, ry: height / 2 - EDGE.y };
  const inner = compact
    ? { rx: width * 0.22, ry: height * 0.22 }
    : bands !== null
      ? {
          rx: bands.rx + ((bands.count - 1) / 2) * bands.step.x,
          ry: bands.ry + ((bands.count - 1) / 2) * bands.step.y,
        }
      : {
          rx: width * (narrow ? 0.17 : 0.25),
          ry: Math.min(height * 0.22, outer.ry - ORBIT_GAP),
        };
  const angles = machineAngles(bands?.slots ?? nodes.length, narrow);
  const slot = (2 * Math.PI) / (bands?.slots ?? nodes.length);
  const agentSpread = (count: number) => Math.min(0.42, slot / (count + 0.6));
  let agentLimit = limits.agents;
  if (bands !== null) {
    // A dense graph shows only as many agents per machine as stay apart in its share of the orbit.
    const { agentReach, agentLabelWidth, agentLabelHeight } = DENSE_GRAPH_NODES;
    const besideLabel = { x: agentLabelWidth + 4, y: agentLabelHeight + 4 };
    const apart = [
      { x: 2 * agentReach + 4, y: 2 * agentReach + 4 },
      { x: agentReach + agentLabelWidth / 2 + 4, y: 2 * agentReach + agentLabelHeight + 5 },
      besideLabel,
    ];
    const fits = (count: number) => {
      const rx = outer.rx * agentSpread(count);
      return rx > besideLabel.x && enclosingRy(rx, apart) <= outer.ry * agentSpread(count);
    };
    while (agentLimit > 1 && !fits(agentLimit)) agentLimit--;
  }

  return {
    center,
    inner,
    outer,
    labelChars:
      bands === null
        ? { name: 18, subtitle: 22, agent: 18 }
        : { name: 14, subtitle: 18, agent: 12 },
    machines: nodes.map((machine, index): FleetLayoutMachine => {
      const angle = angles[index] ?? 0;
      const band = index % (bands?.count ?? 1);
      const rx = bands === null ? inner.rx : bands.rx + band * bands.step.x;
      const ry = bands === null ? inner.ry : bands.ry + band * bands.step.y;
      const x = round(center.x + rx * Math.cos(angle));
      const y = round(center.y + ry * Math.sin(angle));
      const edge = orbitEdge(center, { x, y });
      if (machine === null) {
        return { id: null, x, y, angle, edge, aggregate: folded, agents: [] };
      }
      const agentFold = fold(machine.agents, agentLimit);
      const agentNodes = agentFold.folded
        ? [
            ...agentFold.shown.map((agent) => ({ key: agent.key, aggregate: null })),
            {
              key: machine.id + ":more",
              aggregate: agentFold.folded,
            },
          ]
        : agentFold.shown.map((agent) => ({ key: agent.key, aggregate: null }));
      const spread = agentSpread(agentNodes.length);
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
