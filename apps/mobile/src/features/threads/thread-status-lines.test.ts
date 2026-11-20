import { expect, it, vi } from "vite-plus/test";
import { threadStatusLines } from "./thread-status-lines";

it("keeps background and snooze actions together at the feed end", () => {
  const open = vi.fn();
  const stop = vi.fn();
  const wake = vi.fn();
  const lines = threadStatusLines({
    background: {
      title: "Running jobs",
      waiting: false,
      accessibilityLabel: "Running jobs: build",
      onOpen: open,
      action: {
        label: "Stop",
        accessibilityLabel: "Stop background work",
        disabled: false,
        onPress: stop,
      },
    },
    lifecycle: {
      state: "snoozed",
      label: "Snoozed",
      action: { label: "Wake now", accessibilityLabel: "Wake now", disabled: false, onPress: wake },
    },
  });
  expect(lines.map((line) => line.label)).toEqual(["Running jobs", "Snoozed"]);
  lines[0]?.onOpen?.();
  lines[0]?.action.onPress();
  lines[1]?.action.onPress();
  expect(open).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(wake).toHaveBeenCalledOnce();
});
