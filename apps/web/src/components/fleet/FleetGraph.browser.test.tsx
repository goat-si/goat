import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import "../../index.css";
import { FleetGraph } from "./FleetGraph";
import { fleetHeatDemo } from "./fleetHeatDemo";

const REDUCED = "(prefers-reduced-motion: reduce)";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = "960px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.classList.remove("dark");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

/** Resize observers report in creation order, so once this one has, the graph has measured its width. */
function measured() {
  return new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(container);
  });
}

async function renderDemo() {
  const demo = fleetHeatDemo();
  await act(async () => {
    root.render(
      <FleetGraph
        snapshot={demo.snapshot}
        connections={demo.connections}
        currentMachineId={demo.currentMachineId}
        selectedMachineId={null}
        onSelectMachine={() => {}}
        heat={demo.heat}
      />,
    );
  });
  await act(measured);
  expect(container.querySelector("svg g[data-heat]")).not.toBeNull();
  const node = (label: string) =>
    [...container.querySelectorAll<SVGGElement>("g[data-heat]")].find((element) =>
      element.getAttribute("aria-label")!.startsWith(label + ","),
    )!;
  return node;
}

describe("FleetGraph heat", () => {
  it("sets a burning machine alight and says why", async () => {
    const node = await renderDemo();
    const burning = node("macmini");
    expect(burning.dataset.heat).toBe("burning");
    expect(burning.getAttribute("aria-label")).toContain("Burning: load 1.7/core, CPU 91%");
    expect(burning.querySelector("title")!.textContent).toContain(
      "Burning: load 1.7/core · CPU 91%",
    );

    // Fire lives in the HTML layer behind the graph: flames only where burning, a glow where hot.
    const spots = [...container.querySelectorAll<HTMLElement>(".fleet-heat")];
    expect(spots.map((spot) => spot.dataset.tier).toSorted()).toEqual(["burning", "hot"]);
    const fire = spots.find((spot) => spot.dataset.tier === "burning")!;
    expect(fire.querySelectorAll(".fleet-flame")).toHaveLength(3);
    expect(getComputedStyle(fire.querySelector(".fleet-flames")!).animationName).toBe(
      "fleet-flame",
    );
    expect(fire.querySelectorAll(".fleet-ember")).toHaveLength(2);
    // Hot glows still; only burning moves.
    const glow = spots.find((spot) => spot.dataset.tier === "hot")!;
    expect(glow.querySelector(".fleet-flame")).toBeNull();
    expect(getComputedStyle(glow.querySelector(".fleet-heat-glow")!).animationName).toBe("none");

    // Warm only tints; stale and normal machines show no heat.
    expect(node("macbookpro-2").dataset.heat).toBe("hot");
    expect(node("lidge-ai").dataset.heat).toBe("warm");
    expect(node("lidge-ai").getAttribute("aria-label")).toContain("Warm: Codex weekly 82%");
    expect(node("clisu-oracle").dataset.heat).toBe("normal");
    expect(node("clisu-oracle").querySelector("title")!.textContent).toContain("Metrics not live");
    expect(node("box").dataset.heat).toBe("normal");
    expect(node("box").getAttribute("aria-label")).not.toContain("CPU");
  });

  it("keeps the tier color but drops fire and motion under reduced motion", async () => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(window.matchMedia(REDUCED).matches).toBe(true);
    const node = await renderDemo();
    const burning = node("macmini");
    expect(burning.dataset.heat).toBe("burning");
    expect(container.querySelector(".fleet-heat-layer")).toBeNull();
    expect(container.querySelector(".fleet-orbit")).toBeNull();
    expect(burning.querySelector(".fill-heat-burning\\/25")).not.toBeNull();
  });
});

describe("FleetGraph Boat machines", () => {
  it("marks Boat machines with Boat's logo and state, and a stopped one apart from an away host", async () => {
    const node = await renderDemo();
    const running = node("boat-agent");
    const stopped = node("nightly-ci");

    for (const boat of [running, stopped]) {
      expect(boat.querySelector("svg[data-fleet-boat-logo]")).not.toBeNull();
      expect(boat.getAttribute("aria-label")).toContain("Boat machine");
    }
    expect(node("box").querySelector("svg[data-fleet-boat-logo]")).toBeNull();

    expect(running.textContent).toContain("Boat · Running");
    expect(running.getAttribute("aria-label")).toContain("Connected");
    expect(stopped.textContent).toContain("Boat · Stopped");
    expect(stopped.getAttribute("aria-label")).toContain("Stopped: Resume it in Settings");
    // A stop square, where an unreachable host gets the dashed ring.
    expect(stopped.querySelector("rect")).not.toBeNull();
    expect(stopped.querySelector("circle[stroke-dasharray]")).toBeNull();
  });

  it("draws the mark in Boat's ocean blue on light surfaces and its wash on dark ones", async () => {
    const node = await renderDemo();
    const mark = () =>
      node("nightly-ci").querySelector<SVGSVGElement>("svg[data-fleet-boat-logo]")!;
    expect(getComputedStyle(mark()).fill).toBe("rgb(38, 63, 169)");
    document.documentElement.classList.add("dark");
    expect(getComputedStyle(mark()).fill).toBe("rgb(254, 254, 254)");
  });
});
