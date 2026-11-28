import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../test/render";
import { dismissContextMenu } from "../contextMenuFallback";
import { createLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";

const state = vi.hoisted(() => ({
  allowed: true,
  primaryEnvironmentId: null as EnvironmentId | null,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.search) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.updateMetadata
        ? state.updateMetadata
        : state.openEditor) as never,
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId,
  readPrimaryEnvironmentId: () => state.primaryEnvironmentId,
}));
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ linkedPullRequest: state.linkedPullRequest })) as never,
  useProjects: (() => [
    { id: linkedPullRequest.projectId, environmentId: threadRef.environmentId },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("@goat/client-runtime/change-request-links"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
}));

vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.copy,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import ChatMarkdown from "./ChatMarkdown";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const linkedPullRequest: ThreadLinkedPullRequest = {
  projectId: ProjectId.make("project"),
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: { threadPullRequestLinking: true } },
};

function setup() {
  using stack = new DisposableStack();
  state.allowed = true;
  state.primaryEnvironmentId = null;
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(true);
  state.toast.mockReset();
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  stack.use(vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy));
  stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      await state.copy(await (await item.getType("text/plain")).text());
    }),
  );
  return stack.move();
}

async function renderMarkdown(text: string) {
  const screen = await render(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
  const anchor = () => screen.container.querySelector("a")!;
  return Object.assign(screen, {
    anchor,
    openContextMenu: () =>
      act(async () => {
        anchor().dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      }),
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  using _setup = setup();
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => screen.anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each([
  ["copy-relative", "docs/copy path.md", "relative path"],
  ["copy-full", "/work/docs/copy path.md", "full path"],
])("copies %s without position suffixes", async (action, path) => {
  using _setup = setup();
  state.choose.mockResolvedValue(action);
  await using screen = await renderMarkdown("[Readme](<docs/copy path.md:12:3>)");
  await screen.openContextMenu();
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith(path));
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", description: path }),
  );
});

it.each(["[Docs](https://example.com/docs)", "[Readme](docs/readme.md)"])(
  "tells the native menu for %s whether the keyboard opened it",
  async (text) => {
    using _setup = setup();
    using _bridge = stubGlobal("desktopBridge", {
      showContextMenu: state.choose,
      getLocalEnvironmentBootstraps: () => [],
    });
    await using screen = await renderMarkdown(text);
    // On macOS Shift+F10 does not generate Chromium's keyboard contextmenu.
    await act(async () => {
      screen
        .anchor()
        .dispatchEvent(
          new PointerEvent("contextmenu", { bubbles: true, cancelable: true, button: -1 }),
        );
    });
    expect(state.choose.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(screen.anchor(), { button: "right" });
    await vi.waitFor(() => expect(state.choose.mock.lastCall?.[2]).toBe("mouse"));
  },
);

it.each([
  [0, "[Docs](https://example.com/docs)"],
  [2, "[Docs](https://example.com/docs)"],
  [0, "[Readme](docs/readme.md)"],
  [2, "[Readme](docs/readme.md)"],
])(
  "focuses the first browser action for a keyboard context menu with button %i on %s",
  async (button, text) => {
    using _setup = setup();
    using _bridge = stubGlobal("desktopBridge", undefined);
    state.choose.mockImplementation(createLocalApi().contextMenu.show);
    await using screen = await renderMarkdown(text);
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await userEvent.keyboard("{Tab}");
    const anchor = screen.anchor();
    anchor.focus();
    expect(anchor.matches(":focus-visible")).toBe(true);

    await act(async () => {
      anchor.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button }),
      );
    });

    const firstAction = document.querySelector('[role="menu"] button:not(:disabled)');
    expect(firstAction).not.toBeNull();
    expect(document.activeElement).toBe(firstAction);
  },
);

it("does not launch an editor after revocation during a native context menu", async () => {
  using _setup = setup();
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  using _setup = setup();
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await using screen = await renderMarkdown("[Readme](readme.md)");
  await screen.openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    using _setup = setup();
    state.linkedPullRequest = action === "unlink-from-thread" ? linkedPullRequest : null;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await using screen = await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await screen.openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await screen.openContextMenu();
    await vi.waitFor(() =>
      expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
        },
      }),
    );
  },
);

it("offers no host actions for markdown rendered with file actions off", async () => {
  using _setup = setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  state.primaryEnvironmentId = threadRef.environmentId;
  const startFileDrag = vi.fn().mockResolvedValue(true);
  using _bridge = stubGlobal("desktopBridge", { startFileDrag });
  await using screen = await render(
    <ChatMarkdown
      cwd={undefined}
      environmentId={threadRef.environmentId}
      fileActions={false}
      text="[Readme](/work/docs/readme.md)"
    />,
  );
  const chip = screen.container.querySelector(".chat-markdown-file-link")!;
  await act(async () => {
    chip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
  });
  expect(startFileDrag).not.toHaveBeenCalled();
  expect(chip.getAttribute("draggable")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "File options for readme.md" }));
  await vi.waitFor(() => expect(state.choose).toHaveBeenCalled());
  expect(offeredActions()).toEqual(["copy-full"]);
});

it("preserves keyboard activation of a file-options button", async () => {
  using _setup = setup();
  await using screen = await render(
    <MarkdownFileLink
      environmentId={null}
      href="readme.md"
      targetPath="readme.md"
      iconPath="readme.md"
      workspaceRelativePath="readme.md"
      panelPath={null}
      label="Readme"
      copyMarkdown="[Readme](readme.md)"
      theme="dark"
      onOpenInPanel={vi.fn()}
      resolveCopyPaths={async () => ({ relativePath: "readme.md", fullPath: "/work/readme.md" })}
      openInEditorMenuLabel="Open in editor"
    />,
  );
  const button = screen.container.querySelector("button")!;
  button.focus();
  for (const key of ["{Enter}", " "]) {
    await userEvent.keyboard(key);
    await vi.waitFor(() => expect(state.choose.mock.lastCall?.[2]).toBe("keyboard"));
    state.choose.mockClear();
  }
  await userEvent.click(button);
  await vi.waitFor(() => expect(state.choose.mock.lastCall?.[2]).toBe("mouse"));
});

it.each([
  ["a local file", true, true, true],
  ["a remote file", false, true, true],
  ["an old preload", true, false, true],
  ["a revoked file action", true, true, false],
] as const)(
  "offers Finder drag only for authorized local chips (%s)",
  async (_, local, modern, allowed) => {
    using _setup = setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    using bridge = new DisposableStack();
    state.primaryEnvironmentId = local
      ? threadRef.environmentId
      : EnvironmentId.make("another-host");
    state.allowed = allowed;
    const startFileDrag = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("desktopBridge", modern ? { startFileDrag } : {});
    bridge.defer(() => vi.unstubAllGlobals());

    await using screen = await renderMarkdown("[Readme](docs/readme.md)");
    const chip = screen.container.querySelector(".chat-markdown-file-link")!;
    const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true });
    await act(async () => chip.dispatchEvent(drag));
    if (local && modern && allowed) {
      expect(drag.defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(startFileDrag).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          path: "/work/docs/readme.md",
        }),
      );
    } else {
      expect(chip.getAttribute("draggable")).toBeNull();
      expect(startFileDrag).not.toHaveBeenCalled();
    }
  },
);

it("opens an editor link over the desktop bridge on a click and on a middle-click", async () => {
  using _setup = setup();
  const href = "vscode://file/work/docs/readme.md:3";
  await using screen = await renderMarkdown(`[Open in editor](${href})`);
  for (const [type, button] of [
    ["click", 0],
    ["auxclick", 1],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
    await act(async () => screen.anchor().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(state.openExternal).toHaveBeenLastCalledWith(href);
  }
  expect(state.openExternal).toHaveBeenCalledTimes(2);
});
