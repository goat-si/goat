import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { settingsHelperBounds, watchMacSettingsWindow } from "./MacSettingsWindow.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
let child: NodeEvents.EventEmitter & {
  stdout: NodeEvents.EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  child = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: Object.assign(new NodeEvents.EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
});
it("decodes partial updates and stops the one watcher process on disposal", () => {
  const changed = vi.fn();
  const unavailable = vi.fn();
  const stop = watchMacSettingsWindow(changed, unavailable);
  const state = { x: 10, y: 20, width: 723, height: 719, frontmost: true };
  const line = JSON.stringify(state);
  child.stdout.emit("data", line.slice(0, 8));
  expect(changed).not.toHaveBeenCalled();
  child.stdout.emit("data", line.slice(8) + "\nnull\n");
  expect(changed.mock.calls).toEqual([[state], [null]]);
  stop();
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("exit", 0);
  expect(changed).toHaveBeenCalledTimes(2);
});
it("distinguishes unavailable tracking from a valid absent window", () => {
  const changed = vi.fn();
  const unavailable = vi.fn();
  const stop = watchMacSettingsWindow(changed, unavailable);
  child.stdout.emit("data", '{"x":"bad"}\n');
  expect(changed).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledOnce();
  child.emit("error", new Error("spawn failed"));
  expect(changed).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledTimes(2);
  stop();
});

it.each([
  {
    name: "room below the window",
    settings: { x: 300, y: 100, width: 740, height: 600 },
    side: "below",
  },
  {
    name: "room only to the right",
    settings: { x: 100, y: 100, width: 740, height: 820 },
    side: "right",
  },
  {
    name: "room only to the left",
    settings: { x: 760, y: 100, width: 740, height: 820 },
    side: "left",
  },
  {
    name: "no room outside",
    settings: { x: 316, y: 103, width: 740, height: 821 },
    side: "inside",
  },
])(
  "keeps the list's last rows and its + and − buttons uncovered with $name",
  ({ settings, side }) => {
    const workArea = { x: 0, y: 33, width: 1512, height: 949 };
    const panel = settingsHelperBounds({ ...settings, frontmost: true }, workArea);
    // The bottom strip of the window holds the last rows and the + and − buttons.
    const strip = { top: settings.y + settings.height - 100, bottom: settings.y + settings.height };
    const overlapsStrip =
      panel.x < settings.x + settings.width &&
      panel.x + panel.width > settings.x &&
      panel.y < strip.bottom &&
      panel.y + panel.height > strip.top;
    expect(overlapsStrip).toBe(false);
    expect(panel.x).toBeGreaterThanOrEqual(workArea.x);
    expect(panel.y).toBeGreaterThanOrEqual(workArea.y);
    expect(panel.x + panel.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    const placed =
      panel.y >= settings.y + settings.height
        ? "below"
        : panel.x >= settings.x + settings.width
          ? "right"
          : panel.x + panel.width <= settings.x
            ? "left"
            : "inside";
    expect(placed).toBe(side);
  },
);
it("polls while its parent lives and stops after reparenting to launchd", () => {
  watchMacSettingsWindow(vi.fn(), vi.fn())();
  const script = mocks.spawn.mock.lastCall?.[1][3];
  const imports = new Set<string>();
  const writeData = vi.fn();
  const poll = vi.fn(() => ({ count: 0 }));
  const sleep = vi.fn(() => {
    if (sleep.mock.calls.length > 2) throw new Error("tracker kept polling after parent exit");
  });
  const bridge = Object.assign((line: string) => ({ dataUsingEncoding: () => line }), {
    getppid: () => {
      if (!imports.has("unistd")) throw new Error("unistd bridge unavailable");
      return sleep.mock.calls.length < 2 ? 42 : 1;
    },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: poll },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData } },
    NSThread: { sleepForTimeInterval: sleep },
    NSUTF8StringEncoding: 4,
  });
  NodeVM.runInNewContext(script + "\nrun();", {
    ObjC: { import: (name: string) => imports.add(name) },
    $: bridge,
  });
  expect(poll).toHaveBeenCalledTimes(2);
  expect(writeData.mock.calls).toEqual([["null\n"]]);
});
