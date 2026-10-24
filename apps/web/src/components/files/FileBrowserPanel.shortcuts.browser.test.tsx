import { EnvironmentId, type KeybindingRule, type ProjectEntry } from "@goat/contracts";
import {
  compileResolvedKeybindingRule,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@goat/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<unknown> => ({ _tag: "Failure" })),
  copy: vi.fn(async (_text: string, _target?: string) => true),
  toast: vi.fn(),
  opened: [] as string[],
  keybindings: [] as typeof DEFAULT_RESOLVED_KEYBINDINGS,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: "keybindings" }));
// Contents reads go through the query runner; tests answer them directly.
vi.mock("./projectFilesQueryState", () => ({ getProjectFileQueryAtom: () => "read" }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.readFile }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: vi.fn() }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: vi.fn() } }) }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false, error: null }),
}));
// Folders list their children only once expanded, like the real directory query.
vi.mock("./useDirectoryEntries", async () => {
  const { useState } = await import("react");
  const children: Record<string, ProjectEntry[]> = {
    src: [
      { path: "src/lib", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
    ],
    "src/lib": [
      { path: "src/lib/deep", kind: "directory" },
      { path: "src/lib/util.ts", kind: "file" },
    ],
    "src/lib/deep": [{ path: "src/lib/deep/leaf.ts", kind: "file" }],
    node_modules: [{ path: "node_modules/pkg", kind: "directory", ignored: true }],
  };
  const files = Array.from({ length: 30 }, (_, index) => ({
    path: `f${String(index).padStart(2, "0")}.ts`,
    kind: "file" as const,
  }));
  return {
    useDirectoryEntries: () => {
      const [entries, setEntries] = useState<ProjectEntry[]>([
        { path: "src", kind: "directory" },
        { path: "node_modules", kind: "directory", ignored: true },
        ...files,
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
import { fileSurfaceOwnsFind } from "./fileFindShortcut";

const MAC = /mac|iphone|ipad/i.test(navigator.platform);
const MOD = MAC ? "Meta" : "Control";
const chord = (modifiers: string[], key: string) =>
  `${modifiers.map((m) => `{${m}>}`).join("")}${key}${[...modifiers]
    .reverse()
    .map((m) => `{/${m}}`)
    .join("")}`;

function setup(customRules: KeybindingRule[] = []) {
  state.keybindings = [
    ...DEFAULT_RESOLVED_KEYBINDINGS,
    ...customRules.map((rule) => compileResolvedKeybindingRule(rule)!),
  ];
  state.copy.mockClear();
  state.toast.mockClear();
  state.opened.length = 0;
}

async function renderPanel(props: { hostFolder?: boolean } = {}) {
  const container = document.createElement("div");
  return render(
    <div>
      {/* A stand-in for the composer: shortcuts must leave it alone. */}
      <input aria-label="Composer" />
      {/* Matches FilePreviewPanel's surface root, which takes focus when a file opens. */}
      <div
        data-file-view
        tabIndex={-1}
        style={{ display: "flex", flexDirection: "column", width: 320, height: 240 }}
      >
        <FileBrowserPanel
          environmentId={EnvironmentId.make("local")}
          cwd="/home/dev/repo"
          hostFolder={props.hostFolder ?? false}
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          onOpenFile={(path) => state.opened.push(path)}
          workspaceMutationId={null}
        />
      </div>
    </div>,
    { container, router: false /* the panel renders no links */ },
  );
}

function host(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("file-tree-container");
  expect(element?.shadowRoot, "file tree shadow root").toBeTruthy();
  return element!;
}

function rowIn(container: HTMLElement, path: string): HTMLElement | null {
  return host(container).shadowRoot!.querySelector<HTMLElement>(
    `[data-item-path="${CSS.escape(path)}"]`,
  );
}

async function row(container: HTMLElement, path: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(rowIn(container, path), `row ${path}`).not.toBeNull());
  return rowIn(container, path)!;
}

function focusedRowPath(container: HTMLElement): string | null {
  return host(container).shadowRoot!.activeElement?.getAttribute("data-item-path") ?? null;
}

async function expectFocusedRow(container: HTMLElement, path: string) {
  await vi.waitFor(() => expect(focusedRowPath(container)).toBe(path));
}

async function expectExpanded(container: HTMLElement, path: string, expanded: boolean) {
  await vi.waitFor(() =>
    expect(rowIn(container, path)?.getAttribute("aria-expanded")).toBe(String(expanded)),
  );
}

describe("file tree navigation shortcuts", () => {
  it("moves focus a page at a time with PageDown and PageUp", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    // Rows: node_modules/, src/ with the two children its click revealed, then f00..f29.
    const order = ["node_modules/", "src/", "src/lib/", "src/index.ts"];
    const indexOf = (path: string | null) =>
      path === null
        ? -1
        : order.includes(path)
          ? order.indexOf(path)
          : order.length + Number(path.slice(1, 3));
    const pathAt = (index: number) =>
      order[index] ?? `f${String(index - order.length).padStart(2, "0")}.ts`;
    await row(screen.container, "src/index.ts");
    await userEvent.keyboard("{PageDown}");
    // A page is the rows that fit the panel, so it moves past the next row.
    await vi.waitFor(() => expect(indexOf(focusedRowPath(screen.container))).toBeGreaterThan(2));
    const paged = indexOf(focusedRowPath(screen.container));
    await userEvent.keyboard("{ArrowDown}");
    await expectFocusedRow(screen.container, pathAt(paged + 1));
    await userEvent.keyboard("{PageUp}");
    // Back by the same page from one row further down.
    await expectFocusedRow(screen.container, pathAt(paged + 1 - (paged - 1)));
  });

  it("opens the focused file with Cmd/Ctrl+Down and moves focus to the file view", async () => {
    setup();
    await using screen = await renderPanel();
    // Open the folder with a click, then act on the child it revealed.
    await userEvent.click(await row(screen.container, "src/"));
    await row(screen.container, "src/index.ts");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expectFocusedRow(screen.container, "src/index.ts");
    await userEvent.keyboard(chord([MOD], "{ArrowDown}"));
    await vi.waitFor(() => expect(state.opened).toEqual(["src/index.ts"]));
    expect(document.activeElement?.hasAttribute("data-file-view")).toBe(true);
  });

  it("expands a closed folder with Cmd/Ctrl+Down and keeps it focused", async () => {
    setup();
    await using screen = await renderPanel();
    (await row(screen.container, "src/")).focus();
    await userEvent.keyboard(chord([MOD], "{ArrowDown}"));
    await expectExpanded(screen.container, "src/", true);
    await expectFocusedRow(screen.container, "src/");
    expect(state.opened).toEqual([]);
  });

  it("opens and closes a folder with everything below it using Alt+Right and Alt+Left", async () => {
    setup();
    await using screen = await renderPanel();
    (await row(screen.container, "src/")).focus();
    // Each press reaches the folders listed so far, as in VS Code.
    await userEvent.keyboard(chord(["Alt"], "{ArrowRight}"));
    await expectExpanded(screen.container, "src/", true);
    await userEvent.keyboard(chord(["Alt"], "{ArrowRight}"));
    await expectExpanded(screen.container, "src/lib/", true);
    await userEvent.keyboard(chord(["Alt"], "{ArrowRight}"));
    await expectExpanded(screen.container, "src/lib/deep/", true);
    await row(screen.container, "src/lib/deep/leaf.ts");
    await userEvent.keyboard(chord(["Alt"], "{ArrowLeft}"));
    await expectExpanded(screen.container, "src/", false);
    await expectFocusedRow(screen.container, "src/");
    // The children were closed too: reopening src alone shows lib closed.
    await userEvent.keyboard("{ArrowRight}");
    await expectExpanded(screen.container, "src/lib/", false);
  });

  it("toggles a folder recursively with Alt-click", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.click(await row(screen.container, "src/lib/"));
    await row(screen.container, "src/lib/deep/");
    await userEvent.click(await row(screen.container, "src/"), { modifiers: ["Alt"] });
    await expectExpanded(screen.container, "src/", false);
    await userEvent.click(await row(screen.container, "src/"));
    await expectExpanded(screen.container, "src/lib/", false);
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.click(await row(screen.container, "src/"), { modifiers: ["Alt"] });
    await expectExpanded(screen.container, "src/lib/", true);
  });

  it("collapses and expands every folder, leaving ignored folders closed", async () => {
    setup();
    await using screen = await renderPanel();
    (await row(screen.container, "f00.ts")).focus();
    await userEvent.keyboard(chord([MOD], "{ArrowRight}"));
    await expectExpanded(screen.container, "src/", true);
    await expectExpanded(screen.container, "src/lib/", true);
    await expectExpanded(screen.container, "node_modules/", false);
    await userEvent.keyboard(chord([MOD], "{ArrowLeft}"));
    await expectExpanded(screen.container, "src/", false);
  });

  it("does not expand everything in a host folder", async () => {
    setup();
    await using screen = await renderPanel({ hostFolder: true });
    (await row(screen.container, "f00.ts")).focus();
    await userEvent.keyboard(chord([MOD], "{ArrowRight}"));
    await expectExpanded(screen.container, "src/", false);
  });

  it("answers to a rebound collapse-all key", async () => {
    setup([{ key: "mod+alt+k", command: "files.collapseAll", when: "fileTreeFocus" }]);
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.keyboard(chord([MOD, "Alt"], "k"));
    await expectExpanded(screen.container, "src/", false);
  });
});

describe("file tree search shortcuts", () => {
  it("moves into Search files with Cmd/Ctrl+F and back to the rows with ArrowDown", async () => {
    // chat.find sits after files.find in the defaults, as in a persisted config.
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.keyboard(chord([MOD], "f"));
    const search = screen.getByRole("searchbox", { name: "Search repo files" });
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expectFocusedRow(screen.container, "src/");
    // The next key acts on that row.
    await userEvent.keyboard("{ArrowDown}");
    await expectFocusedRow(screen.container, "src/lib/");
  });

  it("starts a search from a typed letter on a focused row", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.keyboard("f");
    const search = screen.getByRole("searchbox", { name: "Search repo files" });
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue("f");
  });

  it("leaves tree keys to the search field while it has focus", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.click(screen.getByRole("searchbox", { name: "Search repo files" }));
    await userEvent.keyboard(chord([MOD], "{ArrowLeft}"));
    await userEvent.keyboard("{PageDown}");
    await expectExpanded(screen.container, "src/", true);
  });

  it("leaves tree keys alone outside the Files panel", async () => {
    setup();
    await using screen = await renderPanel();
    await userEvent.click(await row(screen.container, "src/"));
    await userEvent.click(screen.getByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard(chord([MOD], "{ArrowLeft}"));
    await userEvent.keyboard(chord(["Alt"], "{ArrowLeft}"));
    await expectExpanded(screen.container, "src/", true);
  });
});

describe("chat find arbitration", () => {
  function findEvent(target: Element, modifiers: Partial<KeyboardEventInit> = {}) {
    const event = new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      metaKey: MAC,
      ctrlKey: !MAC,
      bubbles: true,
      composed: true,
      ...modifiers,
    });
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  it("leaves Cmd/Ctrl+F to the tree, and to chat everywhere else or under a person's chat.find rule", async () => {
    setup();
    await using screen = await renderPanel();
    const tree = host(screen.container);
    const composer = screen.container.querySelector("input")!;
    expect(fileSurfaceOwnsFind(findEvent(tree), state.keybindings)).toBe(true);
    expect(fileSurfaceOwnsFind(findEvent(composer), state.keybindings)).toBe(false);
    expect(fileSurfaceOwnsFind(findEvent(tree, { shiftKey: true }), state.keybindings)).toBe(false);
    setup([{ key: "mod+f", command: "chat.find", when: "fileViewFocus" }]);
    expect(fileSurfaceOwnsFind(findEvent(tree), state.keybindings)).toBe(false);
  });
});
