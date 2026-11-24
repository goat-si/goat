import { expect, it, vi } from "vite-plus/test";
import { appendFindItems } from "./commandPaletteFindItems";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import { canFindPreviewTab } from "./preview/findAvailability";

vi.mock("./preview/previewBridge", () => ({
  previewBridge: { findInPage: vi.fn() },
}));

it("omits browser Find when the native bridge cannot finish a find session", () => {
  const items: CommandPaletteActionItem[] = [];
  appendFindItems(
    items,
    null,
    false,
    canFindPreviewTab({ runtime: "desktop" }, false),
    "Find in browser page",
  );
  expect(items).toEqual([]);
});

it("uses the localized label for an available browser Find action", () => {
  const items: CommandPaletteActionItem[] = [];
  appendFindItems(items, null, false, true, "在浏览器网页中查找");
  expect(items).toMatchObject([{ value: "find-in-browser-page", title: "在浏览器网页中查找" }]);
});
