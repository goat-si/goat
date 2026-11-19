import { EMPTY_TERMINAL_SESSION_STATE } from "@goat/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type FilesystemEntryMetadata,
  type ResolvedKeybindingsConfig,
} from "@goat/contracts";
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } from "@goat/shared/keybindings";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { GhosttyTerminalSurfaceOptions } from "~/terminal/ghostty/surface";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { extractTerminalLinks } from "../terminal-links";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  resetSessions: () => {},
  resizeCommand: {},
  runResize: (_input: unknown): Promise<AsyncResult.AsyncResult<unknown, unknown>> =>
    Promise.resolve(AsyncResult.success(undefined)),
  reportedSize: null as { cols: number; rows: number } | null,
  surfaceOptions: [] as GhosttyTerminalSurfaceOptions[],
  metadata: new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>
  >(),
}));

// Every surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  {
    input: document.createElement("textarea"),
    resendSize: () => {
      const size = fixture.reportedSize;
      if (size) fixture.surfaceOptions.at(-1)?.onResize(size.cols, size.rows);
    },
  },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: (_mount: HTMLElement, options: GhosttyTerminalSurfaceOptions) =>
      new Promise((resolve) => {
        fixture.surfaceOptions.push(options);
        fixture.pendingSurfaces.push(() => resolve(fakeSurface));
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const makeSession = (threadId: ThreadId) =>
    Atom.make({
      ...EMPTY_TERMINAL_SESSION_STATE,
      status: fixture.statusByThreadId.get(threadId) ?? "closed",
      version: 1,
    });
  let sessions = new Map<string, ReturnType<typeof makeSession>>();
  fixture.resetSessions = () => {
    sessions = new Map();
  };
  return {
    attachedTerminalSessionAtom: (
      environmentId: EnvironmentId,
      terminal: { threadId: ThreadId },
    ) => {
      const key = JSON.stringify([environmentId, terminal.threadId]);
      const atom = sessions.get(key) ?? makeSession(terminal.threadId);
      sessions.set(key, atom);
      return atom;
    },
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  readPreparedConnection: () => null,
  usePreparedConnection: () => null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: object) => async (args: unknown) =>
    command === fixture.resizeCommand ? fixture.runResize(args) : AsyncResult.success(undefined),
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../lib/previewShown", async () => {
  const { selectActiveRightPanel, useRightPanelStore } = await import("../rightPanelStore");
  return {
    useRoutePreviewShown: (ref: ScopedThreadRef) =>
      useRightPanelStore((state) => selectActiveRightPanel(state.byThreadKey, ref) === "preview"),
  };
});
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { write: {}, resize: fixture.resizeCommand },
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../state/projects", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    projectEnvironment: {
      fileMetadata: ({
        environmentId,
        input,
      }: {
        environmentId: string;
        input: { path: string };
      }) => {
        const key = JSON.stringify([environmentId, input.path]);
        let atom = fixture.metadata.get(key);
        if (!atom) {
          atom = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
            AsyncResult.success(null),
          );
          fixture.metadata.set(key, atom);
        }
        return atom;
      },
    },
  };
});
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@goat/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  cwd?: string;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  keybindings?: ResolvedKeybindingsConfig;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd={props.cwd ?? "/repo"}
      height={240}
      terminalIds={["term-1"]}
      activeTerminalId="term-1"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={props.keybindings ?? []}
    />
  );
}

function setup() {
  fixture.resetSessions();
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, "exited"],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.surfaceOptions = [];
  fixture.reportedSize = null;
  fixture.runResize = () => Promise.resolve(AsyncResult.success(undefined));
  fixture.metadata.clear();
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  useTerminalUiStateStore.setState(useTerminalUiStateStore.getInitialState());
  return { original, other };
}

it("closes an exited terminal on its own thread after navigating to one reusing its ID", async () => {
  const { original, other } = setup();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <Drawer threadRef={original} onCloseTerminal={onCloseTerminal} />,
  );
  using _timers = fakeTimers();
  // The exit is seen once the surface loads, and its close waits for the next task.
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(onCloseTerminal.mock.calls).toEqual([["term-1", original]]);
});

// Thread navigation defaults have no `!terminalFocus`, so they apply in a focused terminal.
it("hands thread navigation shortcuts from a focused terminal back to the app", async () => {
  const { other: threadRef } = setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useRightPanelStore.getState().openBrowser(threadRef, null);
  await using _screen = await render(
    <Drawer
      threadRef={threadRef}
      onCloseTerminal={() => {}}
      keybindings={compileResolvedKeybindingsConfig([
        ...DEFAULT_KEYBINDINGS,
        { key: "ctrl+r", command: "thread.next", when: "!previewOpen" },
        { key: "ctrl+g", command: "thread.previous", when: "terminalOpen" },
      ])}
    />,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const terminalHandles = (key: string, code: string, shiftKey = true) =>
    fixture.surfaceOptions
      .at(-1)!
      .beforeKey(new KeyboardEvent("keydown", { key, code, ctrlKey: true, shiftKey }));

  expect([terminalHandles("{", "BracketLeft"), terminalHandles("}", "BracketRight")]).toEqual([
    false,
    false,
  ]);
  expect(terminalHandles("C", "KeyC")).toBe(true);
  // Sidebar sees the open preview and the closed drawer and rejects these, so the shell keeps them.
  expect([terminalHandles("r", "KeyR", false), terminalHandles("g", "KeyG", false)]).toEqual([
    true,
    true,
  ]);
});

it("only activates terminal paths confirmed to exist on their environment", async () => {
  const { other: threadRef } = setup();
  const key = (path: string) => JSON.stringify([threadRef.environmentId, path]);
  const pending = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
    AsyncResult.initial(),
  );
  fixture.metadata.set(key("/repo/src/main.ts"), pending);
  fixture.metadata.set(
    key("/repo/src/…notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  fixture.metadata.set(
    key("/repo/src"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "directory" }),
    ),
  );
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const canActivate = (text: string) => fixture.surfaceOptions.at(-1)!.canActivateLink!(text);
  const validate = (text: string) => fixture.surfaceOptions.at(-1)!.validateLink!(text);
  const hover = (text: string | null) =>
    act(() => fixture.surfaceOptions.at(-1)!.onLinkHover!(text));

  expect(canActivate("https://example.com")).toBe(true);
  for (const branch of ["t3/fix-html-image-details", "t3/fix-html-…mage-details"]) {
    const candidates = extractTerminalLinks(branch);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(canActivate(candidate.text)).toBe(false);
      await hover(candidate.text);
      expect(canActivate(candidate.text)).toBe(false);
      expect(await validate(candidate.text)).toBe(false);
    }
  }
  const pressedValidation = validate("src/main.ts:12:7");
  await hover("src/main.ts:12:7");
  expect(canActivate("src/main.ts:12:7")).toBe(false);
  await act(async () => {
    appAtomRegistry.set(pending, AsyncResult.success({ kind: "file" }));
  });
  expect(canActivate("src/main.ts:12:7")).toBe(true);
  expect(await pressedValidation).toBe(true);
  expect(canActivate("missing/file.ts")).toBe(false);
  await hover("missing/file.ts");
  expect(canActivate("missing/file.ts")).toBe(false);
  for (const path of ["/repo/src/…notes.ts", "/repo/src"]) {
    await hover(path);
    expect(canActivate(path)).toBe(true);
  }
  await hover(null);
  expect(canActivate("/repo/src")).toBe(false);
  fixture.metadata.set(
    key("/home/alice/notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} cwd="/home/alice/project" onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  expect(await validate("~/notes.ts:5:2")).toBe(true);
  await hover("~/notes.ts:5:2");
  expect(canActivate("~/notes.ts:5:2")).toBe(true);
});

it("retries a failed measured resize once and then gives up", async () => {
  const { other: threadRef } = setup();
  const resize = vi.fn(async () => AsyncResult.failure(Cause.fail("resize failed")));
  fixture.runResize = resize;
  fixture.reportedSize = { cols: 100, rows: 30 };
  await using _screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await act(async () => {
    fixture.surfaceOptions.at(-1)?.onResize(100, 30);
  });
  await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(resize).toHaveBeenCalledTimes(2);
});

it("does not retry an old resize after the attachment generation changes", async () => {
  const { other: threadRef } = setup();
  const failed = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
  const resize = vi
    .fn()
    .mockImplementationOnce(() => failed.promise)
    .mockResolvedValue(AsyncResult.success(undefined));
  fixture.runResize = resize;
  fixture.reportedSize = { cols: 100, rows: 30 };
  const { attachedTerminalSessionAtom } = await import("../state/terminalSessions");
  const session = attachedTerminalSessionAtom(threadRef.environmentId, {
    threadId: threadRef.threadId,
    terminalId: "term-1",
    cwd: "/repo",
  });
  await using _screen = await render(<Drawer threadRef={threadRef} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await act(async () => {
    fixture.surfaceOptions.at(-1)?.onResize(100, 30);
  });
  expect(resize).toHaveBeenCalledTimes(1);
  await act(async () => {
    const current = appAtomRegistry.get(session);
    appAtomRegistry.set(session as Atom.Writable<typeof current>, {
      ...current,
      output: { ...current.output, generation: current.output.generation + 1 },
    });
  });
  const callsAfterReattach = resize.mock.calls.length;
  await act(async () => {
    failed.resolve(AsyncResult.failure(Cause.fail("resize failed")));
  });
  expect(resize).toHaveBeenCalledTimes(callsAfterReattach);
});
