import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { type ComponentProps } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

const captured = vi.hoisted(() => ({ model: null as unknown }));
// Read the tree model the component builds, so tests can assert its selection and expansion.
vi.mock(import("@pierre/trees/react"), async (original) => {
  const actual = await original();
  const RealFileTree = actual.FileTree;
  return {
    ...actual,
    FileTree: ((props: ComponentProps<typeof RealFileTree>) => {
      captured.model = props.model;
      return <RealFileTree {...props} />;
    }) as typeof RealFileTree,
  };
});

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

function setup() {
  const stack = new AsyncDisposableStack();
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  const container = document.createElement("div");
  container.style.cssText = "display: flex; flex-direction: column; width: 320px; height: 480px";
  captured.model = null;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
    open = true,
    revealRequestId = 0,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
    open?: boolean;
    revealRequestId?: number;
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        open={open}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        revealRequestId={revealRequestId}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
      />
    );
  }

  const model = (): FileTreeModel => captured.model as FileTreeModel;
  const visibleFiles = () =>
    model()
      .getVisibleRows(0, model().getVisibleCount())
      .filter((row) => row.kind === "file")
      .map((row) => row.path);
  const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
  async function filter(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function clearWithEscape() {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      input().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  }

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    if (screen) await screen.rerender(<Panel {...props} />);
    else screen = stack.use(await render(<Panel {...props} />, { container }));
  }

  function row(path: string): HTMLElement {
    const host = container.querySelector("file-tree-container");
    const element = (host?.shadowRoot ?? container).querySelector<HTMLElement>(
      `[data-item-path="${CSS.escape(path)}"]`,
    );
    expect(element, `row ${path}`).not.toBeNull();
    return element!;
  }

  async function activate(target: string | HTMLElement, modifiers: MouseEventInit = {}) {
    await act(async () => {
      (typeof target === "string" ? row(target) : target).dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true,
          button: 0,
          detail: 1,
          ...modifiers,
        }),
      );
    });
  }

  return {
    mount,
    Panel,
    container,
    targets,
    model,
    visibleFiles,
    filter,
    clearWithEscape,
    activate,
    input,
    root: { render: (element: React.ReactNode) => screen!.rerender(element) },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("diff tree file activation", () => {
  it("filters full paths without case sensitivity, reveals collapsed matches, and restores folders", async () => {
    await using fixture = setup();
    const { mount, targets, model, visibleFiles, filter, clearWithEscape, activate } = fixture;

    const files: DiffFileTreeEntry[] = [
      { path: "src/features/Route.ts", status: "added" },
      { path: "src/state/shell.ts", status: "modified" },
      { path: "README.md", status: "deleted" },
    ];
    await mount({ files, selectedPath: files[0]!.path });
    const folder = model().getItem("src/")!;
    if (!("collapse" in folder)) throw new Error("Expected the directory handle");
    await act(async () => folder.collapse());
    expect(visibleFiles()).toEqual(["README.md"]);
    targets.length = 0;

    await filter("  SRC/FEATURES/route  ");
    expect(visibleFiles()).toEqual(["src/features/Route.ts"]);
    expect(targets).toEqual([]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(["README.md"]);
    expect(model().getSelectedPaths()).toContain("src/features/Route.ts");
    expect(targets).toEqual([]);

    // Clearing ends the search session, so later searches remember newer folder choices.
    await activate("src/");
    await filter("README");
    await filter("");
    expect(visibleFiles()).toEqual(files.map((file) => file.path));
  });

  it("keeps an excluded selected file and never reveals a diff just from filtering", async () => {
    await using fixture = setup();
    const { mount, targets, model, visibleFiles, filter, clearWithEscape, activate } = fixture;

    await mount({ selectedPath: "02-short.ts" });
    await filter("01-tall");
    expect(visibleFiles()).toEqual(["01-tall.ts"]);
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("01-tall.ts");
    await activate("01-tall.ts");
    expect(targets).toHaveLength(2);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(entries.map((file) => file.path));
  });

  it("distinguishes no files from no matching files and recovers on clear", async () => {
    await using fixture = setup();
    const { mount, Panel, container, targets, visibleFiles, filter, clearWithEscape, root } =
      fixture;

    await mount({ files: [] });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("No files in this diff.");
    await act(async () => root!.render(<Panel />));
    await filter("missing");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("No matching files.");
    await clearWithEscape();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(visibleFiles()).toEqual(entries.map((file) => file.path));
    expect(targets).toEqual([]);
  });

  it("filters appended and reordered files while preserving the unfiltered expansion", async () => {
    await using fixture = setup();
    const { mount, Panel, targets, visibleFiles, filter, clearWithEscape, activate, root } =
      fixture;

    const files: DiffFileTreeEntry[] = [
      { path: "src/features/route.ts", status: "added" },
      { path: "src/state/shell.ts", status: "modified" },
    ];
    const appended: DiffFileTreeEntry = { path: "test/route.test.ts", status: "added" };
    await mount({ files });
    await activate("src/");
    await filter("route");
    await act(async () => root!.render(<Panel files={[...files, appended]} />));
    expect(visibleFiles()).toEqual([files[0]!.path, appended.path]);
    await act(async () => root!.render(<Panel files={[appended, files[1]!, files[0]!]} />));
    expect(visibleFiles()).toEqual([appended.path, files[0]!.path]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual([appended.path]);
    await activate("src/");
    expect(visibleFiles()).toEqual([appended.path, files[1]!.path, files[0]!.path]);
    expect(targets).toEqual([]);
  });

  it("filters a path that changes from a file to a directory after refresh", async () => {
    await using fixture = setup();
    const { mount, Panel, targets, visibleFiles, filter, activate, root } = fixture;

    await mount({ files: [{ path: "foo", status: "deleted" }] });
    await filter("FOO");
    expect(visibleFiles()).toEqual(["foo"]);
    await act(async () =>
      root!.render(
        <Panel
          files={[
            { path: "foo/bar.ts", status: "added" },
            { path: "other.ts", status: "modified" },
          ]}
        />,
      ),
    );
    expect(visibleFiles()).toEqual(["foo/bar.ts"]);
    await filter("foo/bar");
    expect(visibleFiles()).toEqual(["foo/bar.ts"]);
    await activate("foo/bar.ts");
    expect(targets).toHaveLength(1);
    await filter("  ");
    expect(visibleFiles()).toEqual(["foo/bar.ts", "other.ts"]);
  });

  it("mounts lazily and keeps query and expansion across hiding and reopening", async () => {
    await using fixture = setup();
    const {
      mount,
      Panel,
      container,
      model,
      visibleFiles,
      filter,
      clearWithEscape,
      activate,
      input,
      root,
    } = fixture;

    const files: DiffFileTreeEntry[] = [
      { path: "src/route.ts", status: "modified" },
      { path: "README.md", status: "modified" },
    ];
    await mount({ files, open: false });
    expect(container.querySelector("file-tree-container")).toBeNull();
    await act(async () => root!.render(<Panel files={files} />));
    const tree = model();
    await activate("src/");
    await filter("route");
    await act(async () => root!.render(<Panel files={files} open={false} />));
    expect(container.querySelector("aside")!.hidden).toBe(true);
    expect(container.querySelector("aside")!.inert).toBe(true);
    await act(async () => root!.render(<Panel files={files} />));
    expect(container.querySelector("aside")!.hidden).toBe(false);
    expect(model()).toBe(tree);
    expect(input().value).toBe("route");
    expect(visibleFiles()).toEqual(["src/route.ts"]);
    await clearWithEscape();
    expect(visibleFiles()).toEqual(["README.md"]);
    await act(async () => root!.render(<Panel files={files} open={false} />));
    await act(async () => root!.render(<Panel files={files} />));
    expect(visibleFiles()).toEqual(["README.md"]);
  });
});
