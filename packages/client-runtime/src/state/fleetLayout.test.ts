import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_GRAPH_LIMITS,
  COMPACT_GRAPH_NODES,
  compactGraphHeight,
  MAX_GRAPH_AGENTS,
  MAX_GRAPH_MACHINES,
  layoutFleet,
  type LayoutMachineInput,
} from "./fleetLayout.ts";

const idle = { running: 0, attention: 0, reported: 0 };

function machine(id: string, work = idle, agents = 0): LayoutMachineInput {
  return {
    id,
    ...work,
    agents: Array.from({ length: agents }, (_, index) => ({
      key: id + index,
      ...idle,
      running: 1,
    })),
  };
}

describe("layoutFleet", () => {
  it("places one machine to the right of Main and two on opposite sides", () => {
    const one = layoutFleet([machine("a")], 800, 500);
    expect(one.machines[0]).toMatchObject({ x: 600, y: 250 });
    const two = layoutFleet([machine("a"), machine("b")], 800, 500);
    expect(two.machines.map(({ x }) => x)).toEqual([200, 600]);
  });

  it("keeps every machine and agent node inside the drawing", () => {
    for (const [width, height] of [
      [360, 520],
      [1100, 560],
    ] as const) {
      const layout = layoutFleet(
        Array.from({ length: 9 }, (_, index) => machine("m" + index, idle, 4)),
        width,
        height,
      );
      for (const node of layout.machines.flatMap((entry) => [entry, ...entry.agents])) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x).toBeLessThanOrEqual(width);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeLessThanOrEqual(height);
      }
    }
  });

  it("folds extra machines into one node that keeps their work, showing busy ones first", () => {
    const machines = Array.from({ length: 20 }, (_, index) =>
      machine("m" + index, index === 19 ? { running: 2, attention: 1, reported: 0 } : idle),
    );
    machines[15] = machine("m15", { running: 0, attention: 0, reported: 3 });
    const layout = layoutFleet(machines, 1000, 560);
    expect(layout.machines).toHaveLength(MAX_GRAPH_MACHINES);
    expect(layout.machines.map((node) => node.id)).toContain("m19");
    const folded = layout.machines.at(-1)!;
    expect(folded.id).toBeNull();
    expect(folded.aggregate).toEqual({ count: 9, running: 0, attention: 0, reported: 0 });

    const allBusy = Array.from({ length: 14 }, (_, index) =>
      machine("m" + index, { running: 1, attention: index % 2, reported: 0 }),
    );
    const busyLayout = layoutFleet(allBusy, 1000, 560);
    const shown = busyLayout.machines.filter((node) => node.id !== null).length;
    expect(shown + busyLayout.machines.at(-1)!.aggregate!.count).toBe(14);
    // m11, m12 and m13 fold; m11 and m13 each need the user.
    expect(busyLayout.machines.at(-1)!.aggregate).toMatchObject({ running: 3, attention: 2 });
  });

  it("folds extra agents on a machine into a +N node", () => {
    const layout = layoutFleet([machine("a", idle, 9)], 1000, 560);
    const agents = layout.machines[0]!.agents;
    expect(agents).toHaveLength(MAX_GRAPH_AGENTS);
    expect(agents.at(-1)!.aggregate).toEqual({ count: 4, running: 4, attention: 0, reported: 0 });
  });

  it("keeps phone and tablet touch targets on screen and apart at every fleet size, folding past the cap", () => {
    const limits = COMPACT_GRAPH_LIMITS;
    const machineReach = COMPACT_GRAPH_NODES.machineRadius + COMPACT_GRAPH_NODES.machineHitSlop;
    const agentReach = COMPACT_GRAPH_NODES.agentRadius + COMPACT_GRAPH_NODES.agentHitSlop;
    for (const width of [320, 375, 430, 744, 1024]) {
      const height = compactGraphHeight(width);
      for (let count = 1; count <= 15; count++) {
        const layout = layoutFleet(
          Array.from({ length: count }, (_, index) => machine("m" + index, idle, 8)),
          width,
          height,
          limits,
        );
        expect(layout.machines.length).toBe(Math.min(count, limits.machines));
        const agents = layout.machines.flatMap((node) => node.agents);
        for (const node of layout.machines) {
          expect(node.agents.length).toBeLessThanOrEqual(limits.agents);
        }
        for (const node of [...layout.machines, ...agents]) {
          expect(node.x - machineReach).toBeGreaterThanOrEqual(0);
          expect(node.x + machineReach).toBeLessThanOrEqual(width);
          expect(node.y - machineReach).toBeGreaterThanOrEqual(0);
          expect(node.y + machineReach).toBeLessThanOrEqual(height);
        }
        // Square touch targets: neighbors stay apart when their centers differ by more than the
        // sum of reaches along either axis.
        const separate = (
          nodes: ReadonlyArray<{ readonly x: number; readonly y: number }>,
          others: ReadonlyArray<{ readonly x: number; readonly y: number }>,
          gap: number,
        ) => {
          for (const a of nodes) {
            for (const b of others) {
              if (a === b) continue;
              expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeGreaterThanOrEqual(
                gap,
              );
            }
          }
        };
        separate(layout.machines, layout.machines, 2 * machineReach);
        separate(agents, agents, 2 * agentReach);
        separate(agents, layout.machines, machineReach + agentReach);
      }
    }
  });
});
