import { GTProvider } from "gt-react";
import zh from "../../i18n/translations/zh.json";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { TypographySection } from "./TypographySettings";

const state = vi.hoisted(() => ({ searchTargetId: null as string | null }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));
// The previews mount Ghostty and Shiki, which this test does not exercise.
vi.mock(import("./SettingsFontPreviews"), () => ({
  CodeFontPreview: () => <div />,
  PromptFontPreview: () => <div />,
  TerminalFontPreview: () => <div />,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
}));

function setup(searchTargetId: string | null) {
  state.searchTargetId = searchTargetId;
  removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  return { [Symbol.dispose]: () => removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY) };
}

describe("TypographySection", () => {
  it("persists the advanced flag the terminal reads when a deep link targets an advanced row", async () => {
    using _storage = setup("terminal-font");
    await using screen = await render(<TypographySection />);

    await expect.element(screen.getByRole("heading", { name: "Terminal font" })).toBeVisible();
    expect(getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean)).toBe(true);
  });
  it("localizes simple and advanced typography controls", async () => {
    using _storage = setup(null);
    await using screen = await render(
      <GTProvider locale="zh" translations={{ zh }}>
        <TypographySection />
      </GTProvider>,
    );
    await expect.element(screen.getByRole("heading", { name: "等宽字体" })).toBeVisible();
    await screen.getByRole("switch", { name: "显示高级字体设置" }).click();
    await expect.element(screen.getByRole("combobox", { name: "终端字号" })).toBeVisible();
  });
});
