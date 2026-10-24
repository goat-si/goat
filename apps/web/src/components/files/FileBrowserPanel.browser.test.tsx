import { EnvironmentId, type KeybindingRule, type ProjectEntry } from "@goat/contracts";
import {
  compileResolvedKeybindingRule,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@goat/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { resolveShortcutCommand } from "~/keybindings";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  copy: vi.fn(async (_text: string, _target?: string) => true),
  toast: vi.fn(),
  menu: vi.fn(),
  loads: [] as string[],
  keybindings: [] as typeof DEFAULT_RESOLVED_KEYBINDINGS,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: "keybindings" }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/fileContextMenu", () => ({
  // The shared menu's own copy items resolve against the tree's root; the panel replaces them.
  useFileContextMenu: () => ({
    buildItems: () => [
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ],
    activate: vi.fn(),
  }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: state.menu } }) }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null }),
}));
// Folders list their children only once expanded, like the real directory query,
// so a toggle reshapes the tree under the focused row.
vi.mock("./useDirectoryEntries", async () => {
  const { useState } = await import("react");
  const children: Record<string, ProjectEntry[]> = {
    src: [
      { path: "src/lib", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
    ],
    "src/lib": [{ path: "src/lib/util.ts", kind: "file" }],
  };
  return {
    useDirectoryEntries: () => {
      const [entries, setEntries] = useState<ProjectEntry[]>([
        { path: "src", kind: "directory" },
        { path: "README.md", kind: "file" },
        { path: "notes.md", kind: "file" },
      ]);
      // One load function per mount, like the real hook's stable callback.
      const [load] = useState(() => async (path: string) => {
        state.loads.push(path);
        await Promise.resolve();
        setEntries((current) => [
          ...current,
          ...(children[path] ?? []).filter((entry) => !current.some((e) => e.path === entry.path)),
        ]);
      });
      return {
        entries,
        load,
        refresh: vi.fn(),
        ready: true,
        error: null,
        isPending: false,
        loadingDirectories: new Set<string>(),
      };
    },
  };
});

import FileBrowserPanel from "./FileBrowserPanel";
import { FilePathCopyMenu } from "./FilePathCopyMenu";

const MOD = /mac|iphone|ipad/i.test(navigator.platform) ? "Meta" : "Control";
const COPY_PATH = `{${MOD}>}{Alt>}c{/Alt}{/${MOD}}`;
const COPY_RELATIVE_PATH = `{${MOD}>}{Alt>}{Shift>}c{/Shift}{/Alt}{/${MOD}}`;
const THREAD_COPY_REFERENCE = `{${MOD}>}{Shift>}c{/Shift}{/${MOD}}`;

function setup(customRules: KeybindingRule[] = []) {
  state.keybindings = [
    ...DEFAULT_RESOLVED_KEYBINDINGS,
    ...customRules.map((rule) => compileResolvedKeybindingRule(rule)!),
  ];
  state.copy.mockClear();
  state.toast.mockClear();
  state.menu.mockReset();
  state.loads.length = 0;
}

async function renderPanel(
  props: { cwd?: string; workspaceRoot?: string; hostFolder?: boolean } = {},
) {
  const container = document.createElement("div");
  container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px";
  return render(
    <FileBrowserPanel
      environmentId={EnvironmentId.make("remote-ssh")}
      cwd={props.cwd ?? "/home/dev/repo"}
      workspaceRoot={props.workspaceRoot ?? props.cwd ?? "/home/dev/repo"}
      hostFolder={props.hostFolder ?? false}
      projectName="repo"
      selectedPath={null}
      selectedPathRevealId={0}
      onOpenFile={() => {}}
      workspaceMutationId={null}
    />,
    { container, router: false /* the panel renders no links */ },
  );
}

function treeRoot(container: HTMLElement): ShadowRoot {
  const host = container.querySelector("file-tree-container");
  expect(host?.shadowRoot, "file tree shadow root").toBeTruthy();
  return host!.shadowRoot!;
}

async function row(container: HTMLElement, path: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(() => {
    element = treeRoot(container).querySelector<HTMLElement>(
      `[data-item-path="${CSS.escape(path)}"]`,
    );
    expect(element, `row ${path}`).not.toBeNull();
  });
  return element!;
}

async function expectCopied(shortcut: string, text: string) {
  state.copy.mockClear();
  await userEvent.keyboard(shortcut);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledTimes(1));
  expect(state.copy.mock.calls[0]?.[0]).toBe(text);
}

describe("file tree path copy shortcuts", () => {
  it("copies a file's remote full and workspace-relative path from the clicked row", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await expectCopied(COPY_PATH, "/home/dev/repo/README.md");
    await expectCopied(COPY_RELATIVE_PATH, "README.md");
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "success", title: "Relative path copied" }),
    );
  });

  it("copies a folder right after a click opens it and after a second click closes it", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await row(screen.container, "src/index.ts");
    expect(state.loads).toContain("src");
    await expectCopied(COPY_PATH, "/home/dev/repo/src");
    await expectCopied(COPY_RELATIVE_PATH, "src");

    await userEvent.click(await row(screen.container, "src/"));
    await vi.waitFor(() =>
      expect(
        treeRoot(screen.container).querySelector('[data-item-path="src/index.ts"]'),
      ).toBeNull(),
    );
    await expectCopied(COPY_PATH, "/home/dev/repo/src");
    await expectCopied(COPY_RELATIVE_PATH, "src");
  });

  it("copies the focused folder after the keyboard opens and closes it", async () => {
    setup();
    await using screen = await renderPanel();
    // Rows sort as src/, notes.md, README.md. Arrow keys move focus but leave notes.md selected.
    await userEvent.click(await row(screen.container, "notes.md"));
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{ArrowRight}");
    await row(screen.container, "src/lib/");
    await expectCopied(COPY_PATH, "/home/dev/repo/src");

    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    await row(screen.container, "src/lib/util.ts");
    await expectCopied(COPY_RELATIVE_PATH, "src/lib");

    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{ArrowLeft}");
    await vi.waitFor(() =>
      expect(treeRoot(screen.container).querySelector('[data-item-path="src/lib/"]')).toBeNull(),
    );
    await expectCopied(COPY_RELATIVE_PATH, "src");
  });

  it("copies the selected row while the tree container itself has focus", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await row(screen.container, "src/index.ts");
    treeRoot(screen.container).querySelector<HTMLElement>('[role="tree"]')!.focus();
    await expectCopied(COPY_PATH, "/home/dev/repo/src");
  });

  it("copies every selected row on separate lines", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await userEvent.click(await row(screen.container, "notes.md"), { modifiers: [MOD] });
    await expectCopied(COPY_RELATIVE_PATH, "README.md\nnotes.md");
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "2 relative paths copied" }),
    );
  });

  it("ignores the shortcuts while typing in the file search field", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await userEvent.click(screen.getByRole("searchbox", { name: "Search repo files" }));
    await userEvent.keyboard(COPY_PATH);
    await userEvent.keyboard(COPY_RELATIVE_PATH);
    expect(state.copy).not.toHaveBeenCalled();
  });

  it("ignores a custom copy rule without a when clause while typing in the search field", async () => {
    setup([{ key: "mod+alt+c", command: "files.copyPath" }]);
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await userEvent.click(screen.getByRole("searchbox", { name: "Search repo files" }));
    await userEvent.keyboard(COPY_PATH);
    expect(state.copy).not.toHaveBeenCalled();
  });

  it("lets a copy rule rebound onto another command's keys win over a global capture listener", async () => {
    setup([
      { key: "mod+shift+c", command: "files.copyPath", when: "fileViewFocus && !editableFocus" },
    ]);
    // Mirrors useChatShortcuts: window capture, the chat's own context, and it stops what it handles.
    const taken: string[] = [];
    const chatShortcuts = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, state.keybindings, {
        context: { terminalFocus: false },
      });
      if (command !== "thread.copyReference") return;
      taken.push(command);
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", chatShortcuts, true);
    using _listener = {
      [Symbol.dispose]: () => window.removeEventListener("keydown", chatShortcuts, true),
    };
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await expectCopied(THREAD_COPY_REFERENCE, "/home/dev/repo/README.md");
    expect(taken).toEqual([]);
  });

  it("refuses a relative copy when part of the selection is outside the workspace", async () => {
    setup();
    await using screen = await renderPanel({
      cwd: "/home/dev",
      workspaceRoot: "/home/dev/src",
      hostFolder: true,
    });
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.click(await row(screen.container, "README.md"), { modifiers: [MOD] });
    await userEvent.keyboard(COPY_RELATIVE_PATH);
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "error",
          description: "1 of 2 items are outside /home/dev/src",
        }),
      ),
    );
    expect(state.copy).not.toHaveBeenCalled();
  });

  it("copies a host folder's host path and has no relative path outside the workspace", async () => {
    setup();
    await using screen = await renderPanel({
      cwd: "/srv/shared",
      workspaceRoot: "/home/dev/repo",
      hostFolder: true,
    });
    await userEvent.click(await row(screen.container, "notes.md"));
    await expectCopied(COPY_PATH, "/srv/shared/notes.md");
    state.copy.mockClear();
    await userEvent.keyboard(COPY_RELATIVE_PATH);
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "error", title: "No relative path to copy" }),
      ),
    );
    expect(state.copy).not.toHaveBeenCalled();
  });
});

describe("file tree context menu path copy", () => {
  it("copies a folder from its menu right after toggling it", async () => {
    setup();
    await using screen = await renderPanel({ cwd: "C:\\work\\repo" });
    await userEvent.click(await row(screen.container, "src/"));
    await row(screen.container, "src/index.ts");
    state.menu.mockResolvedValueOnce("copy-full");
    await userEvent.click(await row(screen.container, "src/"), { button: "right" });
    await vi.waitFor(() =>
      expect(state.copy).toHaveBeenCalledWith("C:\\work\\repo\\src", "full path"),
    );
    const items = state.menu.mock.calls[0]?.[0] as Array<{ id: string; label: string }>;
    expect(items.filter((item) => item.id.startsWith("copy-")).map((item) => item.label)).toEqual([
      "Copy relative path (from repo)",
      "Copy full path",
      "Copy mention",
    ]);
  });

  it("copies the whole selection when the menu opens on a selected row", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "README.md"));
    await userEvent.click(await row(screen.container, "notes.md"), { modifiers: [MOD] });
    state.menu.mockResolvedValueOnce("copy-relative");
    await userEvent.click(await row(screen.container, "notes.md"), { button: "right" });
    await vi.waitFor(() =>
      expect(state.copy).toHaveBeenCalledWith("README.md\nnotes.md", "relative path"),
    );
    const items = state.menu.mock.calls[0]?.[0] as Array<{ id: string; label: string }>;
    expect(items.map((item) => item.label)).toContain("Copy relative paths (from repo)");
  });
});

describe("file viewer path copy shortcuts", () => {
  async function renderViewer() {
    return render(
      <div>
        {/* Matches FilePreviewPanel's surface root, which clicks on content focus. */}
        <div data-file-view tabIndex={-1}>
          <FilePathCopyMenu filePath="docs/guide.md" workspaceRoot="/home/dev/repo" />
          <p>Rendered file content</p>
          <input aria-label="Find in file" />
        </div>
        <button type="button">Outside the file view</button>
      </div>,
      { router: false /* no links */ },
    );
  }

  it("copies the open file after a click on its content", async () => {
    setup();
    await using screen = await renderViewer();
    await userEvent.click(screen.getByText("Rendered file content"));
    await expectCopied(COPY_PATH, "/home/dev/repo/docs/guide.md");
    await expectCopied(COPY_RELATIVE_PATH, "docs/guide.md");
  });

  it("ignores the shortcuts outside the view and in its text fields", async () => {
    setup();
    await using screen = await renderViewer();
    await userEvent.click(screen.getByRole("button", { name: "Outside the file view" }));
    await userEvent.keyboard(COPY_PATH);
    await userEvent.click(screen.getByRole("textbox", { name: "Find in file" }));
    await userEvent.keyboard(COPY_PATH);
    expect(state.copy).not.toHaveBeenCalled();
  });
});
