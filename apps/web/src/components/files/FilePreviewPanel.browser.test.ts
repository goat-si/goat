import type { ScopedThreadRef } from "@goat/contracts";
import { EnvironmentId, ProjectReadFileError } from "@goat/contracts";
import type { useFileTree } from "@pierre/trees/react";
import * as Schema from "effect/Schema";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_MENTION_DRAG_TYPE } from "../chat/composerMentionDrag";
import FileBrowserPanel from "./FileBrowserPanel";

const browser = vi.hoisted(() => ({
  options: null as Parameters<typeof useFileTree>[0] | null,
  insert: vi.fn(() => true),
  copy: vi.fn(),
  menu: vi.fn(),
  entries: [{ path: "report.md", kind: "file" as const }],
  load: vi.fn(),
  model: {
    resetPaths: vi.fn(),
    setGitStatus: vi.fn(),
    subscribe: () => () => {},
    isSearchOpen: () => false,
    getItem: vi.fn(),
    getSelectedPaths: () => [],
    getFocusedPath: () => null,
  },
}));

vi.mock("@pierre/trees/react", () => ({
  useFileTree: (options: Parameters<typeof useFileTree>[0]) => {
    browser.options = options;
    return { model: browser.model };
  },
  useFileTreeSearch: () => ({ value: "" }),
  useFileTreeSelector: () => false,
  FileTree: () => createElement("div", { "data-item-path": "report.md" }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({
  useComposerHandleContext: () => ({ current: { insertTextAtEnd: browser.insert } }),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: browser.copy }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: vi.fn() }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: browser.menu } }) }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: browser.entries,
    load: browser.load,
    refresh: vi.fn(),
    ready: true,
    error: null,
    isPending: false,
    loadingDirectories: new Set<string>(),
  }),
}));

import { remapFileCommentAnnotations } from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  resolveFileExplorerTarget,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
  workspaceMediaPreviewUrl,
  workspacePreviewAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe.each([
  ["/srv/notes", "[report.md](/srv/notes/report.md)", "/srv/notes/report.md"],
  ["D:\\notes", "[report.md](D:%5Cnotes%5Creport.md)", "D:\\notes\\report.md"],
  ["/work/repo", "[report.md](report.md)", "report.md"],
])("file tree destination paths rooted at %s", (cwd, mention, path) => {
  it.each(["open", "add-to-chat", "copy-mention", "drag"])(
    "uses the destination path for %s",
    async (action) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.clearAllMocks();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const openFile = vi.fn();
      try {
        await act(() =>
          root.render(
            createElement(FileBrowserPanel, {
              environmentId: EnvironmentId.make("remote"),
              cwd,
              workspaceRoot: "/work/repo",
              projectName: "Project",
              selectedPath: null,
              selectedPathRevealId: 0,
              onOpenFile: openFile,
              workspaceMutationId: null,
            }),
          ),
        );
        if (action === "open") {
          await act(() => browser.options!.onSelectionChange!(["report.md"]));
          expect(openFile).toHaveBeenCalledWith(path);
        } else if (action === "drag") {
          const setData = vi.fn();
          const event = new Event("dragstart", { bubbles: true });
          Object.defineProperty(event, "dataTransfer", { value: { setData } });
          await act(() => container.querySelector("[data-item-path]")!.dispatchEvent(event));
          expect(setData).toHaveBeenCalledWith(COMPOSER_MENTION_DRAG_TYPE, mention);
        } else {
          const contextMenu = browser.options!.composition!.contextMenu!;
          const item = { path: "report.md" } as Parameters<
            NonNullable<typeof contextMenu.onOpen>
          >[0];
          const context = {
            close: vi.fn(),
            anchorElement: container,
          } as unknown as Parameters<NonNullable<typeof contextMenu.onOpen>>[1];
          browser.menu.mockResolvedValue(action);
          await act(async () => contextMenu.onOpen!(item, context));
          if (action === "add-to-chat") {
            expect(browser.insert).toHaveBeenCalledWith(`${mention} `, {
              ensureLeadingBoundary: true,
            });
          } else {
            expect(browser.copy).toHaveBeenCalledWith(mention);
          }
        }
      } finally {
        await act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("directory explorer targets", () => {
  it("reveals workspace directories without changing the tree root", () => {
    expect(resolveFileExplorerTarget("/repo", "src/components", true)).toEqual({
      cwd: "/repo",
      selectedPath: "src/components",
    });
  });

  it.each(["/srv/notes", "/", "D:\\notes", "D:\\", "\\\\host\\share\\"])(
    "browses the outside directory %s as the tree root",
    (path) => {
      expect(resolveFileExplorerTarget("/repo", path, true)).toEqual({
        cwd: path,
        selectedPath: null,
      });
    },
  );

  it("does not treat an absolute file or an empty selection as a directory", () => {
    expect(resolveFileExplorerTarget("/repo", "/srv/file.ts", false)).toEqual({
      cwd: "/repo",
      selectedPath: "/srv/file.ts",
    });
    expect(resolveFileExplorerTarget("/repo", null, false)).toEqual({
      cwd: "/repo",
      selectedPath: null,
    });
  });
});

describe("file preview read errors", () => {
  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
  });
});

describe("workspacePreviewAssetResource", () => {
  const input = {
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
  };

  it("uses a workspace asset inside the workspace and a media asset for a host image", () => {
    expect(
      workspacePreviewAssetResource({
        ...input,
        draft: false,
        absolutePath: "/repo/images/shot.png",
      }),
    ).toEqual({ _tag: "workspace-file", threadId: "thread-1", path: "/repo/images/shot.png" });
    expect(
      workspacePreviewAssetResource({ ...input, draft: false, absolutePath: "/tmp/shot.png" }),
    ).toEqual({ _tag: "media-file", threadId: "thread-1", path: "/tmp/shot.png" });
  });

  it("uses the draft asset for a host image before the server knows the thread", () => {
    expect(
      workspacePreviewAssetResource({ ...input, draft: true, absolutePath: "/tmp/shot.png" }),
    ).toEqual({ _tag: "draft-workspace-file", cwd: "/repo", path: "/tmp/shot.png" });
  });
});

describe("workspaceMediaPreviewUrl", () => {
  it("keeps the signed query while changing the cache key for a file refresh", () => {
    const signedUrl = "https://host.test/assets/shot.png?token=signed";
    const before = workspaceMediaPreviewUrl(signedUrl, null, 0);
    const after = workspaceMediaPreviewUrl(signedUrl, null, 1);
    expect(before).not.toBe(after);
    expect(new URL(after).searchParams.get("token")).toBe("signed");
    expect(new URL(after).searchParams.get("file-refresh")).toBe("1");
  });

  it("changes the cache key after a workspace mutation", () => {
    expect(workspaceMediaPreviewUrl("https://host.test/shot.png", "new revision", 0)).toContain(
      "workspace-revision=new%20revision&file-refresh=0",
    );
  });
});
