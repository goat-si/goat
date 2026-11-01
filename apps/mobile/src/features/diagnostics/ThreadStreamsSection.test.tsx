import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  noteThreadStreamEvents,
  noteThreadStreamOpened,
  resetThreadStreamDiagnosticsForTest,
} from "@goat/client-runtime/state/thread-stream-diagnostics";

const navigation = vi.hoisted(() => ({ focused: true }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => navigation.focused }));
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: () => null }));

import { useThreadStreamDiagnostics } from "./ThreadStreamsSection";

const event = (sequence: number) => ({
  known: 1,
  unknown: 0,
  sequence,
  eventType: null,
  reply: null,
  status: "live",
  hasError: false,
});

it("stops re-rendering while Diagnostics is covered and catches up on return", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetThreadStreamDiagnosticsForTest();
  navigation.focused = true;
  noteThreadStreamOpened("env", "thread");
  const seen: Array<number | null> = [];
  function Probe() {
    seen.push(useThreadStreamDiagnostics()[0]?.lastSequence ?? null);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => noteThreadStreamEvents("env", "thread", event(1)));
  expect(seen.at(-1)).toBe(1);

  navigation.focused = false;
  await act(async () => root.render(<Probe />));
  const rendersWhileCovered = seen.length;
  await act(async () => {
    noteThreadStreamEvents("env", "thread", event(2));
    noteThreadStreamEvents("env", "thread", event(3));
  });
  expect(seen).toHaveLength(rendersWhileCovered);

  navigation.focused = true;
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)).toBe(3);
  await act(async () => root.unmount());
});
