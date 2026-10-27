import { expect, it, vi } from "vite-plus/test";

import type { Device } from "./device.ts";
import type { Rect, Snapshot } from "./checks.ts";
import { runJourney, type StepResult } from "./journey.ts";

vi.mock(import("./device.ts"), () => ({
  BUNDLE_ID: "com.t3tools.t3code.dev",
  delay: async () => {},
}));
vi.mock(import("./video.ts"), () => ({
  lagCheck: async () => ({ check: { name: "video fixture", pass: true, detail: "fixture" } }),
}));

const bottom = { x: 0, y: 750, width: 400, height: 50 };
const rail = { x: 0, y: 0, width: 50, height: 800 };

it.each([
  {
    name: "bottom tabs give way to the thread",
    tabs: bottom,
    pushedTabs: undefined,
    back: true,
    hidden: true,
    passes: true,
  },
  {
    name: "bottom tabs left over the thread fail",
    tabs: bottom,
    pushedTabs: bottom,
    back: true,
    hidden: true,
    passes: false,
  },
  {
    name: "a side rail stays in the thread",
    tabs: rail,
    pushedTabs: rail,
    back: true,
    hidden: false,
    passes: true,
  },
  {
    name: "a side rail still requires a back button",
    tabs: rail,
    pushedTabs: rail,
    back: false,
    hidden: false,
    passes: false,
  },
])("phone journey: $name", async ({ tabs, pushedTabs, back, hidden, passes }) => {
  const snapshot = (tabRect?: Rect, thread = false): Snapshot => ({
    viewport: { width: 400, height: 800 },
    nodes: [
      {
        index: 0,
        label: "New thread",
        kind: "text",
        rect: { x: 60, y: 60, width: 300, height: 30 },
      },
      {
        index: 1,
        label: "Make remote coding feel local",
        ref: "row",
        kind: "text",
        rect: { x: 60, y: 100, width: 300, height: 40 },
      },
      ...(tabRect ? [{ index: 2, kind: "tab-bar", rect: tabRect }] : []),
      ...(thread
        ? [
            {
              index: 3,
              kind: "text-field",
              ref: "composer",
              rect: { x: 60, y: 650, width: 300, height: 40 },
            },
          ]
        : []),
      ...(thread && back
        ? [
            {
              index: 4,
              identifier: "BackButton",
              ref: "back",
              kind: "button",
              rect: { x: 60, y: 20, width: 50, height: 40 },
            },
          ]
        : []),
    ],
  });
  const list = snapshot(tabs);
  const thread = snapshot(pushedTabs, true);
  const waits = [list, list, thread, list];
  const device = {
    pose: { form: "phone", platform: "ios" },
    agent: async () => {},
    openUrl: async () => {},
    screenshot: async () => {},
    snapshot: async () => thread,
    orient: async () => list,
    recorded: async (_directory: string, _name: string, action: () => Promise<unknown>) => {
      await action();
      return "fixture.mp4";
    },
    waitFor: async (predicate: (value: Snapshot) => boolean) => {
      const value = waits.shift();
      if (!value || !predicate(value)) throw new Error("Unexpected device wait");
      return value;
    },
  } as unknown as Device;
  const steps: StepResult[] = [];
  await runJourney(
    device,
    "/tmp/journey-fixture",
    async () => "https://example.invalid/pair",
    steps,
  );
  const checks = steps.find((step) => step.name === "thread")!.checks;
  expect(checks.some((item) => item.name === "tab bar hidden")).toBe(hidden);
  expect(checks.every((item) => item.pass)).toBe(passes);
  expect(checks.find((item) => item.name === "back button visible")?.pass).toBe(back);
});
