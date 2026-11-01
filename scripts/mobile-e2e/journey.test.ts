import { expect, it, vi } from "vite-plus/test";

import { AgentDeviceError, type Device, poolError } from "./device.ts";
import type { Rect, Snapshot } from "./checks.ts";
import { runJourney, type StepResult } from "./journey.ts";

vi.mock(import("./device.ts"), async (original) => ({
  ...(await original()),
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

const loadedApp: Snapshot = {
  viewport: { width: 400, height: 800 },
  nodes: [
    { index: 0, label: "New thread", kind: "text", rect: { x: 60, y: 60, width: 300, height: 30 } },
  ],
};

/** A journey whose app loads, then whose every wait for the paired thread list fails. */
const pairingFails = (failure: Error) => {
  const waits: Array<Snapshot | Error> = [loadedApp];
  const device = {
    pose: { form: "phone", platform: "ios" },
    agent: async () => {},
    openUrl: async () => {},
    screenshot: async () => {},
    waitFor: async () => {
      const next = waits.shift() ?? failure;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Device;
  return runJourney(device, "/tmp/journey-fixture", async () => "https://example.invalid/pair", [])
    .then(() => undefined)
    .catch((error: unknown) => error);
};

it("a pool failure while pairing is reported as the pool's error", async () => {
  const error = await pairingFails(
    new AgentDeviceError("timed out waiting for the paired thread list: Daemon connection closed"),
  );

  expect(error instanceof Error && poolError(error.message)).toBe(true);
});

it("pairing that never shows the threads is an app failure", async () => {
  const error = await pairingFails(new Error("timed out waiting for the paired thread list"));

  expect(error).toEqual(new Error("the app did not show the fixture threads after pairing"));
});

it("an error dialog seen before the pool fails its screenshot stays recorded", async () => {
  const dialog: Snapshot = {
    viewport: { width: 400, height: 800 },
    nodes: [
      {
        index: 0,
        label: "Could not connect",
        kind: "text",
        rect: { x: 60, y: 300, width: 300, height: 30 },
      },
      {
        index: 1,
        label: "Dismiss",
        kind: "button",
        rect: { x: 60, y: 340, width: 100, height: 40 },
      },
    ],
  };
  const device = {
    pose: { form: "phone", platform: "ios" },
    agent: async () => {},
    screenshot: async () => {
      throw new AgentDeviceError("agent-device screenshot: Daemon connection closed");
    },
    waitFor: async () => dialog,
  } as unknown as Device;
  const steps: StepResult[] = [];

  const error = await runJourney(device, "/tmp/journey-fixture", async () => "", steps)
    .then(() => undefined)
    .catch((failure: unknown) => failure);

  expect(error instanceof Error && poolError(error.message)).toBe(true);
  expect(steps.flatMap((step) => step.checks).filter((item) => !item.pass)).toEqual([
    { name: "no error dialog on launch", pass: false, detail: "Could not connect" },
  ]);
  expect(steps[0]?.screenshot).toBeUndefined();
});

/** A phone screen with the fixture thread row, optionally a tab bar, composer and back button. */
const phoneScreen = (options: { tabs?: Rect; thread?: boolean; back?: boolean }): Snapshot => ({
  viewport: { width: 400, height: 800 },
  nodes: [
    { index: 0, label: "New thread", kind: "text", rect: { x: 60, y: 60, width: 300, height: 30 } },
    {
      index: 1,
      label: "Make remote coding feel local",
      ref: "row",
      kind: "text",
      rect: { x: 60, y: 100, width: 300, height: 40 },
    },
    ...(options.tabs ? [{ index: 2, kind: "tab-bar", rect: options.tabs }] : []),
    ...(options.thread
      ? [
          {
            index: 3,
            kind: "text-field",
            ref: "composer",
            rect: { x: 60, y: 650, width: 300, height: 40 },
          },
        ]
      : []),
    ...(options.back
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

/** Walks a phone journey whose screenshot named `failing` is lost to the pool. */
const poolLosesScreenshot = async (waits: Snapshot[], current: Snapshot, failing: string) => {
  const device = {
    pose: { form: "phone", platform: "ios" },
    agent: async () => {},
    openUrl: async () => {},
    screenshot: async (path: string) => {
      if (path.endsWith(failing))
        throw new AgentDeviceError("agent-device screenshot: Daemon connection closed");
    },
    snapshot: async () => current,
    orient: async () => waits[0],
    recorded: async (_directory: string, _name: string, action: () => Promise<unknown>) => {
      await action();
      return "fixture.mp4";
    },
    waitFor: async () => {
      const value = waits.shift();
      if (!value) throw new Error("Unexpected device wait");
      return value;
    },
  } as unknown as Device;
  const steps: StepResult[] = [];
  const error = await runJourney(device, "/tmp/journey-fixture", async () => "", steps)
    .then(() => undefined)
    .catch((failure: unknown) => failure);
  return { error, steps };
};

it("a thread screen failure seen before the pool fails its screenshot stays recorded", async () => {
  const list = phoneScreen({ tabs: bottom });
  const thread = phoneScreen({ thread: true });

  const { error, steps } = await poolLosesScreenshot([list, list, thread], thread, "-thread.png");

  expect(error instanceof Error && poolError(error.message)).toBe(true);
  const step = steps.find((item) => item.name === "thread");
  expect(step?.checks.filter((item) => !item.pass).map((item) => item.name)).toEqual([
    "back button visible",
  ]);
  expect(step?.screenshot).toBeUndefined();
});

it("a back screen failure seen before the pool fails its screenshot stays recorded", async () => {
  const list = phoneScreen({ tabs: bottom });
  const thread = phoneScreen({ thread: true, back: true });
  const backList = phoneScreen({});

  const { error, steps } = await poolLosesScreenshot(
    [list, list, thread, backList],
    thread,
    "-back.png",
  );

  expect(error instanceof Error && poolError(error.message)).toBe(true);
  const step = steps.find((item) => item.name === "back");
  expect(step?.checks.filter((item) => !item.pass).map((item) => item.name)).toEqual([
    "tab bar back",
  ]);
  expect(step?.screenshot).toBeUndefined();
});
