import { expect, it, vi } from "vite-plus/test";
import { appendFindItems } from "./commandPaletteFindItems";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import { canFindPreviewTab } from "./preview/findAvailability";

vi.mock("./preview/previewBridge", () => ({
  previewBridge: { findInPage: vi.fn() },
}));

it("omits browser Find when the native bridge cannot finish a find session", () => {
  const items: CommandPaletteActionItem[] = [];
  appendFindItems(items, null, false, canFindPreviewTab({ runtime: "desktop" }, false));
  expect(items).toEqual([]);
});
