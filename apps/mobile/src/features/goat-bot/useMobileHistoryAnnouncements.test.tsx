import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const spoken = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: (text: string) => spoken.lines.push(text) },
}));

import { useMobileHistoryAnnouncements } from "./useMobileHistoryAnnouncements";

function Probe(props: { incomplete: boolean; failed: boolean }) {
  useMobileHistoryAnnouncements(props);
  return null;
}

it("speaks notices that turn on together once, as one announcement, and nothing on a rerender", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  spoken.lines = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe incomplete={false} failed={false} />));
  expect(spoken.lines).toEqual([]);
  await act(async () => root.render(<Probe incomplete failed />));
  expect(spoken.lines).toEqual(["Older work may be missing. Couldn't load older work."]);
  await act(async () => root.render(<Probe incomplete failed />));
  expect(spoken.lines).toHaveLength(1);
  // A notice that turns off and on again is new news.
  await act(async () => root.render(<Probe incomplete failed={false} />));
  await act(async () => root.render(<Probe incomplete failed />));
  expect(spoken.lines.at(-1)).toBe("Couldn't load older work.");
  await act(async () => root.unmount());
});
