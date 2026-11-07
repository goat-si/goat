import { expect, it } from "vite-plus/test";
import { isPreviewRefreshShortcut } from "./previewRefresh.ts";

it.each([
  ["darwin", true, false, true],
  ["darwin", false, true, false],
  ["linux", false, true, true],
  ["win32", true, false, false],
] as const)(
  "uses the platform refresh chord: %s meta=%s ctrl=%s",
  (platform, meta, control, expected) => {
    expect(
      isPreviewRefreshShortcut(
        { type: "keyDown", key: "r", meta, control, shift: false, alt: false } as Electron.Input,
        platform,
      ),
    ).toBe(expected);
  },
);
