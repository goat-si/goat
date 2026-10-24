import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  EnvironmentId,
  ProjectReadFileError,
  ThreadId,
  type KeybindingRule,
  type ProjectEntry,
  type ProjectReadFileResult,
} from "@goat/contracts";
import {
  compileResolvedKeybindingRule,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@goat/shared/keybindings";
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<unknown> => ({ _tag: "Failure" })),
  copy: vi.fn(async (_text: string, _target?: string) => true),
  toast: vi.fn(),
  reveal: vi.fn(async () => {}),
  refresh: vi.fn(),
  threadFind: vi.fn(),
  threadCopy: vi.fn(),
  keybindings: [] as typeof DEFAULT_RESOLVED_KEYBINDINGS,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: "keybindings" }));
vi.mock("./projectFilesQueryState", () => ({ getProjectFileQueryAtom: () => "read" }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.readFile }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    buildItems: () => [],
    capabilities: { revealLabel: "Reveal in Finder", canOpenDefault: false, editorIds: [] },
    activate: state.reveal,
  }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: vi.fn() } }) }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("./useDirectoryEntries", async () => {
  const { useState } = await import("react");
  const children: Record<string, ProjectEntry[]> = {
    src: [{ path: "src/index.ts", kind: "file" }],
  };
  return {
    useDirectoryEntries: () => {
      const [entries, setEntries] = useState<ProjectEntry[]>([
        { path: "src", kind: "directory" },
        { path: "notes.md", kind: "file" },
      ]);
      const [load] = useState(() => async (path: string) => {
        await Promise.resolve();
        setEntries((current) => [
          ...current,
          ...(children[path] ?? []).filter((entry) => !current.some((e) => e.path === entry.path)),
        ]);
      });
      return {
        entries,
        load,
        refresh: state.refresh,
        ready: true,
        error: null,
        isPending: false,
        loadingDirectories: new Set<string>(),
      };
    },
  };
});

import { useChatShortcuts } from "~/components/chat/useChatShortcuts";
import { isEditableFocused } from "~/lib/editableFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { useRightPanelStore } from "~/rightPanelStore";

import FileBrowserPanel from "./FileBrowserPanel";
import { isPdfFindShortcut } from "./pdf/pdfShortcuts";
import { FileViewMenu, keepsEditorFindAgain } from "./FileViewMenu";
import { claimAwaitedEditorFocus } from "./sourceEditorContent";

const MAC = /mac|iphone|ipad/i.test(navigator.platform);
const MOD = MAC ? "Meta" : "Control";
const chord = (modifiers: string[], key: string) =>
  `${modifiers.map((m) => `{${m}>}`).join("")}${key}${[...modifiers]
    .reverse()
    .map((m) => `{/${m}}`)
    .join("")}`;
const ENVIRONMENT = EnvironmentId.make("local");
const THREAD = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-1"));
const CONTENTS = "one\ntwo\nthree\nfour\n";
const READ: ProjectReadFileResult = {
  relativePath: "src/index.ts",
  contents: CONTENTS,
  byteLength: CONTENTS.length,
  truncated: false,
};

type Order = "persisted" | "new-install";

function setup(customRules: KeybindingRule[] = [], order: Order = "persisted") {
  // Defaults list files.find before chat.find, which is also how an existing install's
  // backfill stores it. The other order puts the chat rule first.
  const defaults =
    order === "persisted"
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : [
          ...DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command === "chat.find"),
          ...DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "chat.find"),
        ];
  state.keybindings = [
    ...defaults,
    ...customRules.map((rule) => compileResolvedKeybindingRule(rule)!),
  ];
  for (const spy of [
    state.readFile,
    state.copy,
    state.toast,
    state.reveal,
    state.refresh,
    state.threadFind,
    state.threadCopy,
  ]) {
    spy.mockClear();
  }
}

/**
 * The chat's real window shortcuts, with ChatView's context and chat.find handler.
 * File views live inside the right panel's [data-preview-panel-mode], so previewFocus
 * holds there and the default chat.find rule (!previewFocus) does not match.
 */
function ChatStandIn() {
  useChatShortcuts({
    enabled: true,
    keybindings: state.keybindings,
    scriptKeybindings: [],
    getShortcutContext: (target) => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: isPreviewFocused(),
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      editableFocus: isEditableFocused(target),
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: { current: null },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {
      "chat.find": ({ event }) => {
        if (isPdfFindShortcut(event)) return false;
        state.threadFind();
      },
      "thread.copyReference": () => {
        state.threadCopy();
      },
    },
    fallback: () => undefined,
  });
  return null;
}

async function renderView(readResult: ProjectReadFileResult | null = READ) {
  return render(
    <div data-preview-panel-mode="inline">
      <ChatStandIn />
      <div
        data-file-view
        tabIndex={-1}
        style={{ display: "flex", flexDirection: "column", height: 360 }}
      >
        <div data-surface-subheader style={{ display: "flex" }}>
          <FileViewMenu
            filePath="src/index.ts"
            workspaceRoot="/home/dev/repo"
            environmentId={ENVIRONMENT}
            threadRef={THREAD}
            readResult={readResult}
            onRefresh={state.refresh}
          />
        </div>
        <div style={{ display: "flex", height: 120 }}>
          <EditProvider createEditor={(type, options, key) => new Editor(type, options, key)}>
            <File
              file={{ name: "index.ts", contents: CONTENTS }}
              edit
              options={{ disableFileHeader: true }}
            />
          </EditProvider>
        </div>
        <input aria-label="Field in the view" />
        <div style={{ display: "flex", flexDirection: "column", height: 160 }}>
          <FileBrowserPanel
            environmentId={ENVIRONMENT}
            cwd="/home/dev/repo"
            projectName="repo"
            selectedPath={null}
            selectedPathRevealId={0}
            onOpenFile={() => {}}
            workspaceMutationId={null}
          />
        </div>
      </div>
    </div>,
    { router: false /* nothing here links */ },
  );
}

function editorRoot(container: HTMLElement): ShadowRoot {
  const host = container.querySelector("diffs-container");
  expect(host?.shadowRoot, "editor shadow root").toBeTruthy();
  return host!.shadowRoot!;
}

async function editorContent(container: HTMLElement): Promise<HTMLElement> {
  await vi.waitFor(() =>
    expect(
      editorRoot(container).querySelector('[role="textbox"][contenteditable="true"]'),
    ).not.toBeNull(),
  );
  return editorRoot(container).querySelector<HTMLElement>(
    '[role="textbox"][contenteditable="true"]',
  )!;
}

const findMode = (container: HTMLElement) =>
  editorRoot(container)
    .querySelector("[data-search-panel] [data-mode]")
    ?.getAttribute("data-mode") ?? null;

function view(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-file-view]")!;
}

function treeRow(container: HTMLElement, path: string): HTMLElement | null {
  return (
    container
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(path)}"]`) ?? null
  );
}

describe.each<Order>(["persisted", "new-install"])(
  "find in the open file (%s keybinding order)",
  (order) => {
    it("opens the editor's find from its text and from the view, never thread find", async () => {
      setup([], order);
      await using screen = await renderView();
      (await editorContent(screen.container)).focus();
      await userEvent.keyboard(chord([MOD], "f"));
      await vi.waitFor(() => expect(findMode(screen.container)).toBe("find"));
      expect(state.threadFind).not.toHaveBeenCalled();
    });

    it("forwards find from the view root to the editor", async () => {
      setup([], order);
      await using screen = await renderView();
      await editorContent(screen.container);
      view(screen.container).focus();
      await userEvent.keyboard(chord([MOD], "f"));
      await vi.waitFor(() => expect(findMode(screen.container)).toBe("find"));
      expect(state.threadFind).not.toHaveBeenCalled();
    });
  },
);

describe("find ownership", () => {
  it("lets a person's own chat.find rule on the same key run thread find", async () => {
    setup([{ key: "mod+f", command: "chat.find", when: "fileViewFocus" }]);
    await using screen = await renderView();
    (await editorContent(screen.container)).focus();
    await userEvent.keyboard(chord([MOD], "f"));
    await vi.waitFor(() => expect(state.threadFind).toHaveBeenCalledTimes(1));
    expect(findMode(screen.container)).toBeNull();
  });

  it("opens find, not Pierre's replace, when files.find is rebound onto the editor's replace key", async () => {
    setup([{ key: "mod+alt+f", command: "files.find", when: "fileViewFocus" }]);
    await using screen = await renderView();
    (await editorContent(screen.container)).focus();
    await userEvent.keyboard(chord([MOD, "Alt"], "f"));
    await vi.waitFor(() => expect(findMode(screen.container)).toBe("find"));
  });

  it("keeps the forwarded find away from a global command bound to the editor's own find key", async () => {
    setup([
      { key: "mod+f", command: "thread.copyReference" },
      { key: "mod+alt+f", command: "files.find", when: "fileViewFocus" },
    ]);
    await using screen = await renderView();
    await editorContent(screen.container);
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt"], "f"));
    await vi.waitFor(() => expect(findMode(screen.container)).toBe("find"));
    expect(state.threadCopy).not.toHaveBeenCalled();
  });

  it("claims nothing in a read-only or rendered view with no editor", async () => {
    setup();
    await using screen = await render(
      <div data-preview-panel-mode="inline">
        <ChatStandIn />
        <div data-file-view tabIndex={-1}>
          <FileViewMenu
            filePath="README.md"
            workspaceRoot="/home/dev/repo"
            environmentId={ENVIRONMENT}
            threadRef={THREAD}
            readResult={READ}
          />
        </div>
      </div>,
      { router: false /* nothing here links */ },
    );
    const seen: boolean[] = [];
    const record = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", record);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("keydown", record) };
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD], "f"));
    // Nothing in the app handles it, so the browser's own find keeps the key.
    expect(seen.at(-1)).toBe(false);
    expect(state.threadFind).not.toHaveBeenCalled();
  });
});

describe("go to line", () => {
  it("opens from the view root, reveals the line on Enter and refuses a line past the end", async () => {
    setup();
    await using screen = await renderView();
    using openFile = vi.spyOn(useRightPanelStore.getState(), "openFile");
    view(screen.container).focus();
    await userEvent.keyboard("{Control>}g{/Control}");
    const field = screen.getByRole("textbox", { name: "Go to line" });
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard("99{Enter}");
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(field);
    await userEvent.keyboard("3{Enter}");
    expect(openFile).toHaveBeenCalledWith(THREAD, "src/index.ts", 3);
    await expect.element(field).not.toBeInTheDocument();
  });

  it("keeps find-next in the editor text while its find bar is open, and opens from the header", async () => {
    setup();
    await using screen = await renderView();
    const content = await editorContent(screen.container);
    content.focus();
    await userEvent.keyboard(chord([MOD], "f"));
    await vi.waitFor(() => expect(findMode(screen.container)).toBe("find"));
    content.focus();
    await userEvent.keyboard(MAC ? chord(["Meta"], "g") : "{Control>}g{/Control}");
    expect(screen.container.querySelector('[aria-label="Go to line"]')).toBeNull();
    // From the header copy button the same Ctrl+G opens Go to line.
    screen.getByRole("button", { name: "Copy file path" }).element().focus();
    await userEvent.keyboard("{Control>}g{/Control}");
    await expect.element(screen.getByRole("textbox", { name: "Go to line" })).toHaveFocus();
  });

  it("decides find-next ownership per platform", () => {
    const key = (init: KeyboardEventInit) =>
      new KeyboardEvent("keydown", { key: "g", code: "KeyG", ...init });
    const open = { inEditor: true, findOpen: true };
    expect(keepsEditorFindAgain(key({ ctrlKey: true }), { ...open, isMac: false })).toBe(true);
    expect(keepsEditorFindAgain(key({ ctrlKey: true }), { ...open, isMac: true })).toBe(false);
    expect(keepsEditorFindAgain(key({ metaKey: true }), { ...open, isMac: true })).toBe(true);
    expect(
      keepsEditorFindAgain(key({ ctrlKey: true }), {
        inEditor: false,
        findOpen: true,
        isMac: false,
      }),
    ).toBe(false);
    expect(
      keepsEditorFindAgain(key({ ctrlKey: true }), {
        inEditor: true,
        findOpen: false,
        isMac: false,
      }),
    ).toBe(false);
  });

  it("does not open from a text field in the view", async () => {
    setup();
    await using screen = await renderView();
    await userEvent.click(screen.getByRole("textbox", { name: "Field in the view" }));
    await userEvent.keyboard("{Control>}g{/Control}");
    expect(screen.container.querySelector('[aria-label="Go to line"]')).toBeNull();
  });
});

describe("tree and viewer focus", () => {
  /** Swaps its editor for each opened file, as FilePreviewPanel keys its editor by path. */
  function SwitchingView(props: { loaded?: boolean }) {
    const [openPath, setOpenPath] = useState("src/index.ts");
    const surface = useRef<HTMLDivElement>(null);
    return (
      <div
        data-file-view
        tabIndex={-1}
        style={{ display: "flex", flexDirection: "column", height: 360 }}
      >
        <div ref={surface} style={{ display: "flex", height: 120 }}>
          {props.loaded === false ? null : (
            <EditProvider createEditor={(type, options, key) => new Editor(type, options, key)}>
              <File
                key={openPath}
                file={{ name: openPath, contents: `// ${openPath}\n` }}
                edit
                editorOptions={{ onAttach: () => claimAwaitedEditorFocus(surface.current) }}
                options={{ disableFileHeader: true }}
              />
            </EditProvider>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", height: 160 }}>
          <FileBrowserPanel
            environmentId={ENVIRONMENT}
            cwd="/home/dev/repo"
            projectName="repo"
            selectedPath={openPath}
            selectedPathRevealId={0}
            onOpenFile={setOpenPath}
            workspaceMutationId={null}
          />
        </div>
      </div>
    );
  }

  it("gives a newly opened file's editor the focus once it replaces the old one", async () => {
    setup();
    await using screen = await render(<SwitchingView />, { router: false /* nothing links */ });
    const first = await editorContent(screen.container);
    await vi.waitFor(() => expect(treeRow(screen.container, "notes.md")).not.toBeNull());
    treeRow(screen.container, "notes.md")!.focus();
    await userEvent.keyboard(chord([MOD], "{ArrowDown}"));
    await vi.waitFor(() =>
      expect(editorRoot(screen.container).activeElement?.textContent).toContain("// notes.md"),
    );
    expect(first.isConnected).toBe(false);
  });

  it("focuses the open file's editor at once when Cmd/Ctrl+Down names that file", async () => {
    setup();
    await using screen = await render(<SwitchingView />, { router: false /* nothing links */ });
    const content = await editorContent(screen.container);
    await vi.waitFor(() => expect(treeRow(screen.container, "src/index.ts")).not.toBeNull());
    treeRow(screen.container, "src/index.ts")!.focus();
    await userEvent.keyboard(chord([MOD], "{ArrowDown}"));
    await vi.waitFor(() => expect(editorRoot(screen.container).activeElement).toBe(content));
  });

  it.each([
    ["Cmd/Ctrl+Down on the open file", [MOD]],
    ["the focus toggle", [MOD, "Alt"]],
  ] as const)("waits for an editor that is still loading after %s", async (_, modifiers) => {
    setup();
    await using screen = await render(<SwitchingView loaded={false} />, {
      router: false /* nothing links */,
    });
    await vi.waitFor(() => expect(treeRow(screen.container, "src/index.ts")).not.toBeNull());
    treeRow(screen.container, "src/index.ts")!.focus();
    await userEvent.keyboard(chord([...modifiers], modifiers.length === 1 ? "{ArrowDown}" : "e"));
    await vi.waitFor(() => expect(document.activeElement).toBe(view(screen.container)));
    await screen.rerender(<SwitchingView loaded />);
    const content = await editorContent(screen.container);
    await vi.waitFor(() => expect(editorRoot(screen.container).activeElement).toBe(content));
  });

  it("switches from the editor to the tree's focused row and back", async () => {
    setup();
    await using screen = await renderView();
    await vi.waitFor(() => expect(treeRow(screen.container, "src/")).not.toBeNull());
    await userEvent.click(treeRow(screen.container, "src/")!);
    const content = await editorContent(screen.container);
    content.focus();
    await userEvent.keyboard(chord([MOD, "Alt"], "e"));
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector("file-tree-container")
          ?.shadowRoot?.activeElement?.getAttribute("data-item-path"),
      ).toBe("src/"),
    );
    // The next key acts on that row.
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector("file-tree-container")
          ?.shadowRoot?.activeElement?.getAttribute("data-item-path"),
      ).toBe("src/index.ts"),
    );
    await userEvent.keyboard(chord([MOD, "Alt"], "e"));
    await vi.waitFor(() => expect(editorRoot(screen.container).activeElement).toBe(content));
  });
});

describe("viewer item actions", () => {
  it("reveals and refreshes the open file", async () => {
    setup();
    await using screen = await renderView();
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt"], "r"));
    await vi.waitFor(() =>
      expect(state.reveal).toHaveBeenCalledWith("reveal-in-folder", {
        environmentId: ENVIRONMENT,
        filePath: "src/index.ts",
        workspaceRoot: "/home/dev/repo",
      }),
    );
    await userEvent.keyboard(chord([MOD, "Alt"], "y"));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("copies the name and the contents only after they are bound, and refuses partial text", async () => {
    setup();
    await using screen = await renderView({ ...READ, truncated: true });
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "n"));
    expect(state.copy).not.toHaveBeenCalled();
    setup([
      { key: "mod+alt+shift+n", command: "files.copyName", when: "fileViewFocus" },
      { key: "mod+alt+shift+v", command: "files.copyContents", when: "fileViewFocus" },
    ]);
    await screen.rerender(
      <div data-file-view tabIndex={-1}>
        <FileViewMenu
          filePath="src/index.ts"
          workspaceRoot="/home/dev/repo"
          environmentId={ENVIRONMENT}
          threadRef={THREAD}
          readResult={{ ...READ, truncated: true }}
        />
      </div>,
    );
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "n"));
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("index.ts", "file name"));
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "error",
          description: "This file is too large to copy whole.",
        }),
      ),
    );
    expect(state.copy).toHaveBeenCalledTimes(1);
  });

  it("copies whole contents and refuses text the server could not decode", async () => {
    setup([{ key: "mod+alt+shift+v", command: "files.copyContents", when: "fileViewFocus" }]);
    await using screen = await renderView();
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith(CONTENTS, "file contents"));
    await screen.rerender(
      <div data-file-view tabIndex={-1}>
        <FileViewMenu
          filePath="src/index.ts"
          workspaceRoot="/home/dev/repo"
          environmentId={ENVIRONMENT}
          threadRef={THREAD}
          readResult={{
            ...READ,
            textFormat: { encoding: "unsupported", bom: false, lineEnding: "lf" },
          }}
        />
      </div>,
    );
    view(screen.container).focus();
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ description: "This file's text encoding cannot be copied." }),
      ),
    );
    expect(state.copy).toHaveBeenCalledTimes(1);
  });
});

describe("tree item actions", () => {
  it("reveals a folder right after a click opens it, and refreshes the listing", async () => {
    setup();
    await using screen = await renderView();
    await vi.waitFor(() => expect(treeRow(screen.container, "src/")).not.toBeNull());
    await userEvent.click(treeRow(screen.container, "src/")!);
    await vi.waitFor(() => expect(treeRow(screen.container, "src/index.ts")).not.toBeNull());
    await userEvent.keyboard(chord([MOD, "Alt"], "r"));
    await vi.waitFor(() =>
      expect(state.reveal).toHaveBeenCalledWith("reveal-in-folder", {
        environmentId: ENVIRONMENT,
        filePath: "src",
        workspaceRoot: "/home/dev/repo",
      }),
    );
    await userEvent.keyboard(chord([MOD, "Alt"], "y"));
    expect(state.refresh).toHaveBeenCalled();
  });

  it("copies a row's name and a file's contents, refusing binary files", async () => {
    setup([
      { key: "mod+alt+shift+n", command: "files.copyName", when: "fileViewFocus" },
      { key: "mod+alt+shift+v", command: "files.copyContents", when: "fileViewFocus" },
    ]);
    await using screen = await renderView();
    await vi.waitFor(() => expect(treeRow(screen.container, "notes.md")).not.toBeNull());
    await userEvent.click(treeRow(screen.container, "notes.md")!);
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "n"));
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("notes.md", "file name"));
    state.readFile.mockResolvedValueOnce({
      _tag: "Success",
      value: { ...READ, contents: "# Notes" },
    });
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("# Notes", "file contents"));
    state.readFile.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new ProjectReadFileError({
          cwd: "/home/dev/repo",
          relativePath: "notes.md",
          failure: "binary_file",
        }),
      ),
    });
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ description: "Binary files cannot be copied as text." }),
      ),
    );
  });

  it("refuses to copy a folder's contents", async () => {
    setup([{ key: "mod+alt+shift+v", command: "files.copyContents", when: "fileViewFocus" }]);
    await using screen = await renderView();
    await vi.waitFor(() => expect(treeRow(screen.container, "src/")).not.toBeNull());
    treeRow(screen.container, "src/")!.focus();
    await userEvent.keyboard(chord([MOD, "Alt", "Shift"], "v"));
    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Select one file to copy its contents" }),
      ),
    );
    expect(state.readFile).not.toHaveBeenCalled();
  });
});
