import { EnvironmentId, type EditorId } from "@goat/contracts";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  config: {
    availableEditors: [] as EditorId[],
    shellRevealInFileManager: false,
    environment: { platform: { os: "linux" } },
  },
  openEditor: vi.fn(),
  copy: vi.fn().mockResolvedValue(true),
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.config }));
vi.mock("./state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "open" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.openEditor }));
vi.mock("./hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("./rightPanelStore", () => ({ useRightPanelStore: {} }));

import {
  buildFileContextMenuItems,
  resolveFileContextMenuAbsolutePath,
  useFileContextMenu,
} from "./fileContextMenu";

const BASE_TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  filePath: "src/index.ts",
  workspaceRoot: "/workspace/project",
};

const EMPTY_CAPABILITIES = {
  revealLabel: undefined,
  canOpenDefault: false,
  editorIds: [],
};

function assertDefined<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeTruthy();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["src/index.ts", "logs/build:2026"])(
  "copies literal path %s through a copy-only menu while keeping host actions unavailable",
  async (filePath) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let menu: ReturnType<typeof useFileContextMenu> | undefined;
    function Harness() {
      const contextMenu = useFileContextMenu(BASE_TARGET.environmentId);
      useEffect(() => {
        menu = contextMenu;
      }, [contextMenu]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Harness));
    });
    try {
      assertDefined(menu);
      const target = { ...BASE_TARGET, filePath };
      expect(menu.buildItems(target).map((item) => item.id)).toEqual([
        "copy-relative",
        "copy-full",
      ]);
      await menu.activate("copy-relative", target);
      await menu.activate("copy-full", target);
      expect(state.copy.mock.calls).toEqual([
        [filePath, "relative path"],
        [`/workspace/project/${filePath}`, "full path"],
      ]);
      await menu.activate("open", BASE_TARGET);
      await menu.activate("reveal-in-folder", BASE_TARGET);
      await menu.activate("editor:vscode", BASE_TARGET);
      expect(state.openEditor).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

describe("resolveFileContextMenuAbsolutePath", () => {
  it("strips the repository prefix when the repo root is nested in the workspace", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "packages/app/src/index.ts",
      }),
    ).toBe("/workspace/project/packages/app/src/index.ts");
  });

  it("returns null for paths outside the workspace when a repository root is set", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: "/workspace/project/packages/app",
        repositoryRoot: "/workspace/project",
        filePath: "other/src/index.ts",
      }),
    ).toBeNull();
  });

  it("rejects absolute paths without a workspace root, matching diff path resolution", () => {
    expect(
      resolveFileContextMenuAbsolutePath({
        ...BASE_TARGET,
        workspaceRoot: undefined,
        filePath: "/absolute/src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("buildFileContextMenuItems", () => {
  it("offers open, reveal, and an open-with submenu when all are available", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      hasFullPath: true,
      capabilities: {
        revealLabel: "Reveal in Finder",
        canOpenDefault: true,
        editorIds: ["vscode", "cursor", "file-manager"],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "open",
      "reveal-in-folder",
      "open-with",
      "copy-relative",
      "copy-full",
    ]);
    expect(items[0]).toMatchObject({ label: "Open" });
    expect(items[1]).toMatchObject({ label: "Reveal in Finder" });
    const openWith = items[2];
    assertDefined(openWith);
    expect(openWith.children?.map((child) => child.id)).toEqual(["editor:vscode", "editor:cursor"]);
  });

  it("offers only the reveal item when just reveal is enabled", () => {
    const items = buildFileContextMenuItems({
      hasAbsolutePath: true,
      hasRelativePath: true,
      hasFullPath: true,
      capabilities: {
        revealLabel: "Reveal in File Explorer",
        canOpenDefault: false,
        editorIds: [],
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "reveal-in-folder",
      "copy-relative",
      "copy-full",
    ]);
    expect(items[0]).toMatchObject({ label: "Reveal in File Explorer" });
  });

  it("offers nothing when the path cannot be resolved", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: false,
        hasRelativePath: false,
        hasFullPath: false,
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([]);
  });

  it("keeps copying available without shell or editor capabilities", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: true,
        hasRelativePath: true,
        hasFullPath: true,
        capabilities: EMPTY_CAPABILITIES,
      }),
    ).toEqual([
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
  });

  it("can copy a relative path without a resolvable host path", () => {
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: false,
        hasRelativePath: true,
        hasFullPath: false,
        capabilities: {
          revealLabel: "Reveal in Finder",
          canOpenDefault: true,
          editorIds: ["vscode"],
        },
      }),
    ).toEqual([{ id: "copy-relative", label: "Copy relative path" }]);
  });
});
