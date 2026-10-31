import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_GRAPH_NODES,
  compactGraphHeight,
  compactGraphLimits,
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

  it("keeps compact touch targets and machine labels on screen and apart at phone and tablet widths", () => {
    const nodes = COMPACT_GRAPH_NODES;
    const machineReach = nodes.machineRadius + nodes.machineHitSlop;
    const agentReach = nodes.agentRadius + nodes.agentHitSlop;
    // Graph widths after the Usage screen's 20 pt padding on 320, 375, 390, 430, 744 and 1024 pt screens.
    for (const width of [280, 335, 350, 390, 704, 984]) {
      const height = compactGraphHeight(width);
      const limits = compactGraphLimits(width);
      for (let count = 1; count <= 15; count++) {
        const layout = layoutFleet(
          Array.from({ length: count }, (_, index) => machine("m" + index, idle, 8)),
          width,
          height,
          limits,
        );
        expect(layout.machines.length).toBe(Math.min(count, limits.machines));
        const boxes = layout.machines.flatMap((node, index) => {
          expect(node.agents.length).toBeLessThanOrEqual(limits.agents);
          return [
            { owner: index, ...square(node, machineReach) },
            {
              owner: index,
              left: node.x - nodes.labelWidth / 2,
              right: node.x + nodes.labelWidth / 2,
              top: node.y + nodes.machineRadius,
              bottom: node.y + nodes.machineRadius + nodes.labelHeight,
            },
            ...node.agents.map((agent) => ({ owner: -1, ...square(agent, agentReach) })),
          ];
        });
        for (const box of boxes) {
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(width);
          expect(box.top).toBeGreaterThanOrEqual(0);
          expect(box.bottom).toBeLessThanOrEqual(height);
        }
        for (const [index, a] of boxes.entries()) {
          for (const b of boxes.slice(index + 1)) {
            // A machine's own label sits right under its node.
            if (a.owner >= 0 && a.owner === b.owner) continue;
            const overlaps =
              a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            expect(overlaps, JSON.stringify({ width, count, a, b })).toBe(false);
          }
        }
      }
    }
  });
});

function square(point: { readonly x: number; readonly y: number }, reach: number) {
  return {
    left: point.x - reach,
    right: point.x + reach,
    top: point.y - reach,
    bottom: point.y + reach,
  };
}
