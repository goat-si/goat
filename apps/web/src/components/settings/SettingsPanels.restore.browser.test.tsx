import {
  DEFAULT_SNOOZE_PRESETS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@goat/contracts";
import { useEffect } from "react";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { useSettingsRestore } from "./SettingsPanels";
import { sortSnoozeRows } from "./SnoozePresetsSettings.logic";

async function changedLabels(settings: UnifiedSettings) {
  state.settings = settings;
  let labels: ReadonlyArray<string> = [];
  function Probe() {
    const result = useSettingsRestore();
    useEffect(() => {
      labels = result.changedSettingLabels;
    });
    return null;
  }
  await using _screen = await render(<Probe />);
  return labels;
}

it("agrees with the snooze row that its reset restored the defaults, at any time of day", async () => {
  // After 18:00 the passed "today" option sorts last in the row's menu order.
  const evening = new Date(2026, 9, 28, 19, 0);
  const rowOrder = sortSnoozeRows(DEFAULT_SNOOZE_PRESETS, [0, 1, 2, 3, 4], evening).presets;
  expect(rowOrder).not.toEqual(DEFAULT_SNOOZE_PRESETS);
  expect(await changedLabels({ ...DEFAULT_UNIFIED_SETTINGS, snoozePresets: rowOrder })).toEqual([]);
  expect(
    await changedLabels({
      ...DEFAULT_UNIFIED_SETTINGS,
      snoozePresets: DEFAULT_SNOOZE_PRESETS.slice(1),
    }),
  ).toEqual(["Snooze options"]);
});

it("restores automatic server updates after an opt-out", async () => {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, automaticServerUpdates: false };
  state.confirm.mockResolvedValue(true);
  let restore: ReturnType<typeof useSettingsRestore>;
  function Probe() {
    const result = useSettingsRestore();
    useEffect(() => {
      restore = result;
    });
    return null;
  }
  await using _screen = await render(<Probe />);
  expect(restore!.changedSettingLabels).toEqual(["Automatic server updates"]);
  await act(() => restore!.restoreDefaults());
  expect(state.update.mock.calls[0]?.[0].automaticServerUpdates).toBe(true);
});
