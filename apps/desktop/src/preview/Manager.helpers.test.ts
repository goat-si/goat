import { describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  clipboard: { write: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(), getFocusedWebContents: vi.fn() },
}));

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("keeps a form POST in the original native child", () => {
    // Reopening the URL as a GET would drop the body and destroy the opener.
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("popup");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "not a url",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("deny");
    }
  });

  it("keeps blank children alive for a later sign-in redirect", () => {
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("popup");
      }
    }
  });
});
