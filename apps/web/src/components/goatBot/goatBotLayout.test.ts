import { describe, expect, it } from "vite-plus/test";

import { goatBotHomeOpenedAs, goatBotTaskBeside, goatBotViewFitsHome } from "./goatBotLayout";

// The interface font size sets the root size, 12 to 20px; the chat keeps 25rem and Home 22rem.
describe("the task pane goes beside the chat only when the chat keeps 25rem, and a docked Home 22rem", () => {
  it.each([
    { remPx: 16, rowWidth: 720, homeDocked: false, beside: true },
    { remPx: 16, rowWidth: 719, homeDocked: false, beside: false },
    { remPx: 16, rowWidth: 1072, homeDocked: true, beside: true },
    { remPx: 16, rowWidth: 1071, homeDocked: true, beside: false },
    { remPx: 20, rowWidth: 820, homeDocked: false, beside: true },
    { remPx: 20, rowWidth: 819, homeDocked: false, beside: false },
    { remPx: 20, rowWidth: 1260, homeDocked: true, beside: true },
    { remPx: 20, rowWidth: 1259, homeDocked: true, beside: false },
    { remPx: 12, rowWidth: 620, homeDocked: false, beside: true },
    { remPx: 12, rowWidth: 884, homeDocked: true, beside: true },
    { remPx: 12, rowWidth: 883, homeDocked: true, beside: false },
  ])(
    "root $remPx px, row $rowWidth, Home docked $homeDocked",
    ({ remPx, rowWidth, homeDocked, beside }) => {
      expect(
        goatBotTaskBeside({ windowWide: true, besideSetting: true, rowWidth, homeDocked, remPx }),
      ).toBe(beside);
    },
  );

  it.each([
    { windowWide: false, besideSetting: true },
    { windowWide: true, besideSetting: false },
  ])("window wide $windowWide, setting $besideSetting: never beside", (layout) => {
    expect(goatBotTaskBeside({ ...layout, rowWidth: 1600, homeDocked: false, remPx: 16 })).toBe(
      false,
    );
  });
});

describe("Home docks only when the chat view keeps the chat's 25rem beside its 22rem", () => {
  it.each([
    { remPx: 16, width: 752, fits: true },
    { remPx: 16, width: 751, fits: false },
    { remPx: 20, width: 940, fits: true },
    { remPx: 20, width: 939, fits: false },
    { remPx: 12, width: 564, fits: true },
    { remPx: 12, width: 563, fits: false },
    { remPx: 16, width: 0, fits: null },
  ])("a $width px chat view at a $remPx px root", ({ remPx, width, fits }) => {
    expect(goatBotViewFitsHome(width, remPx)).toBe(fits);
  });

  it.each([
    { windowWide: true, width: 752, openedAs: "docked" },
    { windowWide: true, width: 751, openedAs: "sheet" },
    { windowWide: false, width: 1200, openedAs: "sheet" },
    { windowWide: true, width: 0, openedAs: null },
  ])(
    "Home opened with the window wide $windowWide and a $width px chat view: $openedAs",
    ({ windowWide, width, openedAs }) => {
      expect(goatBotHomeOpenedAs({ windowWide, viewFits: goatBotViewFitsHome(width, 16) })).toBe(
        openedAs,
      );
    },
  );
});
