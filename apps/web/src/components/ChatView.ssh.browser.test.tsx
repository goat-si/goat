import { fakeTimers } from "../../test/render";
import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ComposerContextId,
  SshWorkspaceError,
  type SshWorkspaceLaunchResult,
  type SshHostStatus,
} from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { createModelSelection } from "@goat/shared/model";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  SshConnectionProfile,
  SshConnectionTarget,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import { createEnvironmentPresentationAtoms } from "@goat/client-runtime/state/presentation";
import * as chatViewLogic from "./ChatView.logic";
// Browser module namespaces cannot be spied on, so expose the scheduler as a mock that keeps its real behavior.
vi.mock("./ChatView.logic", async (original) => {
  const actual = await original<typeof import("./ChatView.logic")>();
  return {
    ...actual,
    scheduleEnvironmentReconnectWarning: vi.fn(actual.scheduleEnvironmentReconnectWarning),
  };
});
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimeline } from "./chat/MessagesTimeline";
import type { ChatComposer, ChatComposerHandle } from "./chat/ChatComposer";
const state = vi.hoisted(() => ({
  registry: null as import("effect/reactivity").AtomRegistry.AtomRegistry | null,
  primaryConnection: null as EnvironmentConnectionPresentation | null,
  launch: vi.fn(),
  navigate: vi.fn(),
  retry: vi.fn(),
  normal: vi.fn(),
  uploads: vi.fn(),
  toast: vi.fn(),
  shell: vi.fn(),
  composer: null as ComponentProps<typeof ChatComposer> | null,
  timeline: null as ComponentProps<typeof MessagesTimeline> | null,
  mountTimeline: null as (() => void) | null,
  replaceTimeline: null as (() => void) | null,
  scrollNode: null as HTMLDivElement | null,
  list: null as LegendListRef | null,
  contentLength: 1000,
  scrollToEnd: vi.fn(),
  // Stable like the real store selectors; a fresh array per render loops the timeline.
  empty: [] as never[],
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (v: unknown) => v,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ latestLocation: { pathname: "/", state: {} } }),
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (v: unknown) => unknown }) =>
    select({ href: "/", state: {} }),
  useParams: () => ({}),
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS }),
  useClientSettings: (select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
}));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
  useRenderedAppearance: () => "light",
}));
vi.mock("../hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../hooks/useThreadActions", async (original) => ({
  ...(await original<typeof import("../hooks/useThreadActions")>()),
  useThreadActions: () => ({}),
  useAcknowledgeThreadWoke: () => vi.fn(),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  readPreparedConnection: () => Option.none(),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({
    data: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.normal,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.uploads }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === vcsEnvironment.sshWorkspaceLaunch
      ? state.launch
      : command === environmentCatalog.retryNow
        ? state.retry
        : vi.fn(),
}));
vi.mock("../state/terminalSessions", async (original) => ({
  ...(await original<typeof import("../state/terminalSessions")>()),
  useKnownTerminalSessions: () => null,
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("../state/projectClones", async (original) => ({
  ...(await original<typeof import("../state/projectClones")>()),
  useProjectClone: () => null,
}));
vi.mock("../state/device", async (original) => ({
  ...(await original<typeof import("../state/device")>()),
  useDeviceState: () => ({
    state: { onboardingCompleted: false, hosts: [], sessions: {} },
    isReady: true,
  }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      state.primaryConnection ? { ...primary, connection: state.primaryConnection } : primary,
    ],
  }),
  usePrimaryEnvironment: () => primary,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProject: () => project,
  useProjects: () => [project],
  useThreadShell: () => null,
  useThreadProjection: () => null,
  useThreadStatus: () => null,
  useThreadHistory: () => ({ hasMoreHistory: false }),
  useThreadVisibleTurnItems: () => state.empty,
  useThreadCheckpointSummaries: () => state.empty,
  useThreadRefs: () => state.empty,
  useEnvironmentThreadRefs: () => state.empty,
  useChildThreadInputs: () => state.empty,
  useEnvironmentSupportsServerBrowser: () => false,
  resolveThreadDetailRef: () => null,
  waitForThreadShell: state.shell,
}));
vi.mock("../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({ refresh: () => {}, pending: false, environmentId: null }),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("../remoteOpen", async (original) => ({
  ...(await original<typeof import("../remoteOpen")>()),
  useRemoteOpenState: () => ({}),
}));
vi.mock("./chat/useAutoBalanceUpdateBanner", () => ({ useAutoBalanceUpdateBanner: () => null }));
vi.mock("./ThreadStatusIndicators", () => ({ useLinkedThreadPullRequest: () => null }));
vi.mock("./chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./chat/ThreadDetailsPanel", () => ({ ThreadDetailsPanel: () => null }));
// Keep the real ChatView controller and DOM events; replace only the virtualizer boundary.
vi.mock("./chat/MessagesTimeline", async () => {
  const React = await import("react");
  const { resolveTimelineIsAtEnd } = await import("./chat/MessagesTimeline.logic");
  const listsByNode = new WeakMap<HTMLDivElement, LegendListRef>();
  return {
    MessagesTimeline: (props: ComponentProps<typeof MessagesTimeline>) => {
      state.timeline = props;
      const [version, setVersion] = React.useState(0);
      state.mountTimeline = () => setVersion(1);
      state.replaceTimeline = () => setVersion((current) => current + 1);
      // Like LegendList, the ref keeps its identity across re-renders of the same list.
      const attach = (node: HTMLDivElement | null) => {
        state.scrollNode = node;
        const existing = node ? listsByNode.get(node) : undefined;
        const list = !node
          ? null
          : (existing ??
            ({
              getScrollableNode: () => node,
              getState: () => ({
                data: [0],
                scroll: node.scrollTop,
                scrollLength: 400,
                contentLength: state.contentLength,
                positionAtIndex: () => 0,
                sizeAtIndex: () => state.contentLength,
              }),
              scrollToItem: () => Promise.resolve(),
              scrollToEnd: () => {
                state.scrollToEnd();
                node.scrollTop = state.contentLength - 400;
              },
            } as unknown as LegendListRef));
        if (node && list) listsByNode.set(node, list);
        state.list = list;
        props.listRef.current = list;
        props.onScrollableNodeChange?.(node);
      };
      if (!version) return null;
      return (
        <div
          key={version}
          data-timeline
          style={{ height: 400, overflow: "auto" }}
          ref={attach}
          onScroll={() => {
            const atEnd = resolveTimelineIsAtEnd(props.listRef.current?.getState());
            if (atEnd !== undefined) props.onIsAtEndChange(atEnd);
          }}
        >
          <div style={{ height: state.contentLength }} />
        </div>
      );
    },
  };
});
vi.mock("./chat/DraftHeroHeadline", () => ({ DraftHeroHeadline: () => null }));
vi.mock("./chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: () => null,
  ExpandedImageDialogHost: () => null,
  openExpandedImagePreview: () => {},
}));
vi.mock("./PullRequestThreadDialog", () => ({ PullRequestThreadDialog: () => null }));
vi.mock("./ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("./ui/sidebar", () => ({
  useSidebar: () => ({ state: "expanded", isMobile: false }),
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./chat/ChatComposer", async () => {
  const React = await import("react");
  return {
    ChatComposer: (props: ComponentProps<typeof ChatComposer>) => {
      state.composer = props;
      React.useImperativeHandle(
        props.composerRef,
        () =>
          ({
            getSendContext: () => ({
              answeringPendingUserInput: false,
              multipleModelSelections: props.multipleModelSelections,
              providerAvailable: false,
              selectedProvider: "codex",
              selectedModel: "model",
              selectedProviderModels: [],
              selectedPromptEffort: null,
              selectedModelSelection: selection,
              interactionMode: "default",
              interactionModeEnabled: true,
            }),
            validateProviderInput: () => true,
            resetCursorState: () => {},
            focus: () => {},
            focusAtEnd: () => {},
            restoreAfterTimelineReachedEnd: () => {},
            collapseForTimelineScrollKey: () => {},
          }) as unknown as ChatComposerHandle,
      );
      return (
        <div data-editor="editable">
          {props.bannerItems.map((item) => (
            <div key={item.id} data-banner={item.id}>
              {item.title}
              {item.description}
              {item.actions}
            </div>
          ))}
          <button onClick={() => void props.onSend()}>Send</button>
        </div>
      );
    },
  };
});
// Browser mocks snapshot exports; forward method reads to the registry under test.
vi.mock("../rpc/atomRegistry", async (original) => {
  const actual = await original<typeof import("../rpc/atomRegistry")>();
  state.registry = actual.appAtomRegistry;
  return {
    ...actual,
    appAtomRegistry: new Proxy(actual.appAtomRegistry, {
      get: (_target, key) => {
        const value = Reflect.get(state.registry!, key);
        return typeof value === "function" ? value.bind(state.registry) : value;
      },
    }),
  };
});
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { environmentCatalog } from "../connection/catalog";
import { vcsEnvironment } from "../state/vcs";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  environmentServerConfigsAtom,
} from "../state/server";
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: Atom.Atom<unknown>) => {
      if (atom === environmentCatalog.catalogValueAtom) return catalog;
      if (atom === primaryServerAvailableEditorsAtom) return [];
      if (atom === primaryServerKeybindingsAtom) return DEFAULT_RESOLVED_KEYBINDINGS;
      if (atom === environmentServerConfigsAtom) return new Map();
      if (atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)) return true;
      return actual.useAtomValue(atom);
    },
  };
});
import { ThreadRouteView } from "./ThreadRouteView";
import ChatView from "./ChatView";
const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
const selection = createModelSelection(ProviderInstanceId.make("codex"), "model");
const project = {
  id: ProjectId.make("project"),
  environmentId: local,
  workspaceRoot: "/tmp/project",
  name: "Project",
  scripts: [],
  defaultModelSelection: selection,
  defaultThreadEnvMode: "local",
  createdAt: "2026-01-01T00:00:00Z",
};
const primary = {
  environmentId: local,
  label: "Local",
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
  connection: { phase: "connected" },
  serverConfig: null,
};
const destination = { connectionId: "saved", environmentId: remote };
const entry = {
  target: new SshConnectionTarget({ environmentId: remote, connectionId: "saved", label: "Build" }),
  profile: Option.some(
    new SshConnectionProfile({
      environmentId: remote,
      connectionId: "saved",
      label: "Build",
      target: { alias: "build", hostname: "build", username: null, port: null },
    }),
  ),
  enabled: true,
};
const catalog = { isReady: true, entries: new Map([[remote, entry]]) };
const id = DraftId.make("A");
const store = () => useComposerDraftStore.getState();
const result: SshWorkspaceLaunchResult = {
  operationId: "12345678",
  snapshotRef: "ref",
  snapshotOid: "oid",
  remoteEnvironmentId: remote,
  remoteProjectId: ProjectId.make("remote-project"),
  remoteThreadId: ThreadId.make("remote-thread"),
  remoteRepoPath: "/remote",
  branch: "branch",
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
async function mount(draftId = id) {
  await act(async () =>
    root.render(
      <AppAtomRegistryProvider>
        <ThreadRouteView target={{ kind: "draft", draftId }} />
      </AppAtomRegistryProvider>,
    ),
  );
}
beforeEach(() => {
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockReset();
  state.primaryConnection = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { onMenuAction: () => () => {} },
  });
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  state.composer?.onMultipleModelSelectionsChange(null);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    rewindingThreadKeys: new Set(),
  });
  store().setLogicalProjectDraftThreadId("source", scopeProjectRef(local, project.id), id, {
    threadId: ThreadId.make("A"),
    envMode: "worktree",
    sshDestination: destination,
  });
  store().setPrompt(id, "Text");
  store().setModelSelection(id, selection);
  state.timeline = null;
  state.mountTimeline = null;
  state.replaceTimeline = null;
  state.scrollNode = null;
  state.list = null;
  state.contentLength = 1000;
  state.scrollToEnd.mockReset();
  state.launch.mockReset().mockResolvedValue({ _tag: "Success", value: result });
  state.navigate.mockReset().mockImplementation(async (request) => {
    if (request.to === "/$environmentId/$threadId")
      flushSync(() => root.render(<div data-remote-thread={request.params.threadId} />));
  });
  state.shell.mockReset().mockResolvedValue(true);
  state.retry.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.normal.mockReset();
  state.uploads.mockReset();
  state.toast.mockReset();
  const registry = state.registry!;
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((atom: Atom.Atom<unknown>) =>
    atom === environmentCatalog.catalogValueAtom
      ? catalog
      : atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)
        ? true
        : get(atom)) as typeof registry.get);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("never calls normal launch or uploads for SSH send", async () => {
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.normal).not.toHaveBeenCalled();
  expect(state.uploads).not.toHaveBeenCalled();
});

it("deletes an unchanged submitted draft only after remote navigation succeeds", async () => {
  const launch = deferred<Awaited<ReturnType<typeof state.launch>>>(),
    shell = deferred<boolean>(),
    nav = deferred<void>();
  const shellEntered = deferred<void>(),
    navEntered = deferred<void>();
  state.launch.mockImplementation(() => launch.promise);
  state.shell.mockImplementation(() => {
    shellEntered.resolve();
    return shell.promise;
  });
  state.navigate.mockImplementation(async (request) => {
    navEntered.resolve();
    await nav.promise;
    flushSync(() => root.render(<div data-remote-thread={request.params.threadId} />));
  });
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
  });
  expect(state.composer!.isSendBusy).toBe(true);
  expect(store().getDraftSession(id)).not.toBeNull();
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
    await shellEntered.promise;
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    shell.resolve(true);
    await navEntered.promise;
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(store().getComposerDraft(id)?.prompt).toBe("Text");
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: remote, threadId: result.remoteThreadId },
    replace: true,
  });
  await act(async () => {
    nav.resolve();
    await sending;
  });
  expect(store().getDraftSession(id)).toBeNull();
  expect(store().getComposerDraft(id)).toBeNull();
  expect(store().getDraftSessionByLogicalProjectKey("source")).toBeNull();
  expect(state.navigate).toHaveBeenCalledTimes(1);
});
it.each([true, false])(
  "preserves content added during launch by simulated desktop capture (open=%s)",
  async (opens) => {
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    state.shell.mockResolvedValue(opens);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    await act(async () =>
      store().addImage(id, {
        id: "capture",
        type: "image",
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:capture",
        file: new File(["x"], "capture.png"),
      }),
    );
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Text");
    expect(store().getComposerDraft(id)?.images).toHaveLength(1);
    expect(store().getDraftSession(id)?.sshDestination).toEqual(destination);
    if (!opens) {
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: "Started on Build, but could not open the thread",
          actionProps: expect.objectContaining({ children: "Open thread" }),
        }),
      );
      expect(state.composer!.isSendBusy).toBe(false);
    }
  },
);
it.each(["shell", "navigation"])("preserves text and contexts added during %s", async (stage) => {
  const wait = deferred<boolean>(),
    nav = deferred<void>(),
    entered = deferred<void>();
  state.shell.mockImplementation(() => {
    if (stage === "shell") entered.resolve();
    return stage === "shell" ? wait.promise : Promise.resolve(true);
  });
  state.navigate.mockImplementation(async () => {
    entered.resolve();
    await nav.promise;
    flushSync(() => root.render(<div />));
  });
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
    await entered.promise;
  });
  await act(async () => {
    store().setPrompt(id, "Pasted new text");
    store().setThreadContexts(id, [
      {
        version: 1,
        contextId: ComposerContextId.make("context"),
        label: "Context",
        kind: "thread",
        environmentId: local,
        threadId: ThreadId.make("context"),
        title: "Context",
      },
    ]);
  });
  await act(async () => {
    wait.resolve(true);
    nav.resolve();
    await sending;
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("Pasted new text");
  expect(store().getComposerDraft(id)?.threadContexts).toHaveLength(1);
});
it.each(["validate", "preflight", "snapshot", "remote_init", "push", "launch"] as const)(
  "keeps the entire current draft when launch fails at %s",
  async (stage) => {
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    await act(async () => store().setPrompt(id, "Text plus edits"));
    // Preserve the wire error through the actual atom-command squash boundary.
    await act(async () => {
      launch.resolve({
        _tag: "Failure",
        cause: Cause.fail(new SshWorkspaceError({ code: "invalid_target", stage })),
      });
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Text plus edits");
    expect(store().getDraftSession(id)?.sshDestination).toEqual(destination);
    expect(store().getDraftSessionByLogicalProjectKey("source")?.draftId).toBe(id);
    expect(state.composer!.isSendBusy).toBe(false);
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: `Build · ${stage} · invalid_target` }),
    );
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  new SshWorkspaceError({ code: "launch_uncertain", stage: "launch" }),
  { launchMayHaveStarted: true },
  new Error("transport interrupted"),
])("reports an uncertain launch without automatic retry %j", async (error) => {
  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
  });
  await act(async () => store().setPrompt(id, "Current text"));
  await act(async () => {
    launch.reject(error);
    await sending;
  });
  expect(store().getComposerDraft(id)?.prompt).toBe("Current text");
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.composer!.isSendBusy).toBe(false);
  expect(state.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      title:
        "The thread may already have started on Build; check its threads before sending again.",
    }),
  );
});
it.each([false, true])(
  "shows Open thread after navigation timeout (changed=%s)",
  async (changed) => {
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    state.shell.mockResolvedValue(false);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    if (changed) await act(async () => store().setPrompt(id, "new content"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(store().getDraftSessionByLogicalProjectKey("source")?.draftId).toBe(id);
    expect(store().getComposerDraft(id)?.prompt ?? "").toBe(changed ? "new content" : "");
    const toast = state.toast.mock.calls.at(-1)![0];
    expect(toast.title).toBe("Started on Build, but could not open the thread");
    expect(toast.description).toContain(result.remoteThreadId);
    expect(toast.actionProps.children).toBe("Open thread");
    const before = store().getComposerDraft(id);
    state.shell.mockResolvedValue(true);
    await act(async () => {
      toast.actionProps.onClick();
    });
    expect(state.retry).toHaveBeenCalledWith(remote);
    expect(state.launch).toHaveBeenCalledTimes(1);
    expect(store().getComposerDraft(id)).toEqual(before);
  },
);
it.each([false, true])(
  "keeps the ordinary session and Open action when opening keeps failing (changed=%s)",
  async (changed) => {
    state.shell.mockRejectedValue(new Error("shell failed"));
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    if (changed) await act(async () => store().setPrompt(id, "New text"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    const before = store().getComposerDraft(id);
    const toast = state.toast.mock.calls.at(-1)![0];
    catalog.entries.delete(remote);
    await act(async () => toast.actionProps.onClick());
    catalog.entries.set(remote, entry);
    expect(state.retry).not.toHaveBeenCalled();
    expect(store().getComposerDraft(id)).toEqual(before);
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(state.toast.mock.calls.at(-1)![0].actionProps.children).toBe("Open thread");
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("reports started-not-opened for a mismatched saved environment", async () => {
  state.launch.mockResolvedValue({
    _tag: "Success",
    value: { ...result, remoteEnvironmentId: EnvironmentId.make("wrong") },
  });
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.shell).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(store().getDraftSession(id)).not.toBeNull();
  const toast = state.toast.mock.calls.at(-1)![0];
  expect(toast.description).toContain("different environment");
  await act(async () => toast.actionProps.onClick());
  expect(state.retry).toHaveBeenCalledWith(remote);
  expect(state.shell).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});
it.each([false, true])(
  "keeps a newer draft untouched after navigation away (A changed=%s)",
  async (changed) => {
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    const b = DraftId.make("B");
    await act(async () => {
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), b, {
        threadId: ThreadId.make("B"),
      });
      store().setPrompt(b, "B text");
    });
    await mount(b);
    if (changed) await act(async () => store().setPrompt(id, "Changed A"));
    await act(async () => {
      launch.resolve({ _tag: "Success", value: result });
      await sending;
    });
    expect(store().getComposerDraft(b)?.prompt).toBe("B text");
    expect(store().getComposerDraft(id)?.prompt ?? "").toBe(changed ? "Changed A" : "");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.toast.mock.calls.at(-1)![0].actionProps.children).toBe("Open thread");
  },
);
it.each(["success", "failure", "uncertain"])(
  "preserves content added on A after A→B→A during a deferred %s",
  async (outcome) => {
    const launch = deferred<unknown>();
    state.launch.mockImplementation(() => launch.promise);
    await mount();
    let sending: unknown;
    await act(async () => {
      sending = state.composer!.onSend();
    });
    const b = DraftId.make("B");
    await act(async () => {
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), b, {
        threadId: ThreadId.make("B"),
      });
      store().setPrompt(b, "B text");
    });
    await mount(b);
    await mount();
    await act(async () => store().setPrompt(id, "Changed after remount"));
    await act(async () => {
      if (outcome === "success") launch.resolve({ _tag: "Success", value: result });
      else
        launch.reject(
          new SshWorkspaceError({
            code: outcome === "failure" ? "launch_refused" : "launch_uncertain",
            stage: "launch",
          }),
        );
      await sending;
    });
    expect(store().getComposerDraft(id)?.prompt).toBe("Changed after remount");
    expect(store().getComposerDraft(b)?.prompt).toBe("B text");
    expect(store().getDraftSession(id)).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("serializes duplicate send activation in the mounted instance", async () => {
  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  let sending: unknown;
  await act(async () => {
    sending = state.composer!.onSend();
    state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
    await sending;
  });
});
it.each(["image", "file", "hydration", "context", "fanout"])(
  "rejects %s before command dispatch",
  async (kind) => {
    await mount();
    await act(async () => {
      if (kind === "image")
        store().addImages(id, [
          {
            id: "image",
            type: "image",
            name: "image",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "blob:image",
            file: new File(["x"], "image"),
          },
        ]);
      if (kind === "file")
        store().addFiles(id, [
          {
            id: "file",
            type: "file",
            name: "file",
            mimeType: "text/plain",
            sizeBytes: 1,
            file: new File(["x"], "file"),
          },
        ]);
      if (kind === "hydration") {
        const content = store().getComposerDraft(id)!;
        useComposerDraftStore.setState({
          draftsByThreadKey: {
            ...store().draftsByThreadKey,
            [id]: { ...content, nonPersistedImageIds: ["pending"] },
          },
        });
      }
      if (kind === "context")
        store().setThreadContexts(id, [
          {
            version: 1,
            contextId: ComposerContextId.make("context"),
            label: "Context",
            kind: "thread",
            environmentId: local,
            threadId: ThreadId.make("context"),
            title: "Context",
          },
        ]);
      if (kind === "fanout") state.composer!.onMultipleModelSelectionsChange([]);
    });
    await act(async () => {
      await state.composer!.onSend();
    });
    expect(state.launch).not.toHaveBeenCalled();
    expect(state.normal).not.toHaveBeenCalled();
    expect(state.uploads).not.toHaveBeenCalled();
  },
);
it("requires a new explicit send after a definitive prelaunch failure", async () => {
  state.launch.mockRejectedValueOnce(
    new SshWorkspaceError({ code: "host_unavailable", stage: "preflight" }),
  );
  await mount();
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.composer!.isSendBusy).toBe(false);
  await act(async () => {
    await state.composer!.onSend();
  });
  expect(state.launch).toHaveBeenCalledTimes(2);
});

// Reuse this ChatView integration harness for scroll behavior as well as SSH sends.
describe("timeline follow navigation", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    fakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => vi.useRealTimers());

  // Server-thread routes reuse ChatView; exercise that lifetime without a keyed remount.
  async function mountReusedView(draftId = id) {
    const session = store().getDraftSession(draftId)!;
    await act(() =>
      root.render(
        <AppAtomRegistryProvider>
          <ChatView
            routeKind="draft"
            draftId={draftId}
            environmentId={session.environmentId}
            threadId={session.threadId}
          />
        </AppAtomRegistryProvider>,
      ),
    );
  }
  async function flushFrame() {
    const pending = [...frames.values()];
    frames.clear();
    await act(() => pending.forEach((callback) => callback(0)));
  }
  async function mountList() {
    await act(() => state.mountTimeline!());
    state.scrollNode!.scrollTop = 600;
    await flushFrame();
  }
  async function wheel(deltaY: number, offset: number) {
    await act(() => {
      state.scrollNode!.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
      state.scrollNode!.scrollTop = offset;
      state.scrollNode!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  }
  // Simulate the virtualizer's observable append behavior at its public follow boundary.
  async function append(growth = 100) {
    state.contentLength += growth;
    (state.scrollNode!.firstElementChild as HTMLElement).style.height = `${state.contentLength}px`;
    if (state.timeline!.liveFollowEnabled) {
      state.scrollNode!.scrollTop = state.contentLength - 400;
    }
    await act(() => state.scrollNode!.dispatchEvent(new Event("scroll", { bubbles: true })));
  }
  async function clickScrollToEnd() {
    await wheel(-400, 200);
    await act(() => vi.advanceTimersByTime(150));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Scroll to end"]');
    expect(button).not.toBeNull();
    await act(() => button!.click());
  }

  it("keeps manual reading position after a timeline mounts later than thirteen frames", async () => {
    await mount();
    for (let frame = 0; frame < 20; frame++) await flushFrame();
    await mountList();
    await wheel(-200, 400);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(400);
  });

  it("resumes following after a twenty-pixel upward scroll and return to the end", async () => {
    await mount();
    await mountList();
    await wheel(-20, 580);
    // A small stream chunk keeps both notifications inside the same 40px end band.
    await append(10);
    expect(state.scrollNode!.scrollTop).toBe(580);
    await wheel(30, 610);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(710);
  });

  it("does not resume following on another upward scroll within the end band", async () => {
    await mount();
    await mountList();
    await wheel(-20, 580);
    await wheel(-10, 570);
    await append();
    expect(state.scrollNode!.scrollTop).toBe(570);
  });

  it("cancels a scheduled scroll to end when later manual navigation wins", async () => {
    await mount();
    await mountList();
    await clickScrollToEnd();
    const pending = frames.get(nextFrame)!;
    await wheel(-20, 180);
    await flushFrame();
    // Even a callback already dispatched by the browser must respect the generation fence.
    await act(() => pending(0));
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(180);
  });

  it("does not scroll a replacement list from a previously scheduled request", async () => {
    await mount();
    await mountList();
    await clickScrollToEnd();
    await act(() => state.replaceTimeline!());
    state.scrollNode!.scrollTop = 123;
    await flushFrame();
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(123);
  });

  it("cancels a scheduled scroll to end on thread switch", async () => {
    await mountReusedView();
    await mountList();
    await clickScrollToEnd();
    const pending = frames.get(nextFrame)!;
    const other = DraftId.make("B");
    await act(() =>
      store().setLogicalProjectDraftThreadId("other", scopeProjectRef(local, project.id), other, {
        threadId: ThreadId.make("B"),
        envMode: "local",
      }),
    );
    await mountReusedView(other);
    await act(() => state.mountTimeline!());
    state.scrollNode!.scrollTop = 123;
    await flushFrame();
    await act(() => pending(0));
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    expect(state.scrollNode!.scrollTop).toBe(123);
  });

  it("scrolls to end on the next frame when no later navigation intervenes", async () => {
    await mount();
    await mountList();
    await clickScrollToEnd();
    expect(state.scrollToEnd).not.toHaveBeenCalled();
    await flushFrame();
    expect(state.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(state.scrollNode!.scrollTop).toBe(600);
  });
});

it("uses reconciled SSH presentation in the chat banner while keeping fresh failures visible", async () => {
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockImplementation((show) => {
    show();
    return () => {};
  });
  const identity = { supervisorId: "chat-fixture", attemptId: 2, routeId: "ssh-fixture-route" };
  const connection: EnvironmentConnectionPresentation = {
    phase: "reconnecting",
    stage: "opening",
    error: "OLD SETUP TIMEOUT",
    traceId: null,
    failure: { kind: "retrying", reason: "timeout", detail: "OLD SETUP TIMEOUT" },
    failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
    sshRuntimeReady: {
      ...identity,
      operationId: "fixture-op",
      attachmentId: "fixture-attachment",
      runtimeStatus: {
        host: "fixture-vps",
        state: "ready",
        runtimeVersion: "0.4.3",
        requestedVersion: "0.4.3",
      },
    },
  };
  state.primaryConnection = connection;
  await mount();
  const banner = () => container.querySelector('[data-banner^="environment-unavailable:"]');
  expect(banner()?.textContent).toContain("Runtime ready · Opening connection");
  expect(banner()?.textContent).not.toContain("OLD SETUP TIMEOUT");
  for (const reason of ["timeout", "authentication", "transport"] as const) {
    state.primaryConnection = {
      ...connection,
      error: "FRESH FAILURE",
      failure: { kind: "retrying", reason, detail: "FRESH FAILURE" },
      failureOrigin: {
        ...identity,
        attemptId: 3,
        stage: "opening",
        setupTimeout: reason === "timeout",
      },
    };
    await act(async () => root.render(<div />));
    await mount();
    expect(banner()?.textContent).toContain("FRESH FAILURE");
  }
  state.primaryConnection = {
    ...connection,
    sshPreparation: {
      ...identity,
      operationId: "fixture-op",
      phase: "uploading",
      hostAnswered: true,
    },
  };
  await act(async () => root.render(<div />));
  await mount();
  expect(banner()?.textContent).toContain(
    "Installing GOAT runtime — first setup can take a few minutes",
  );
  expect(banner()?.textContent).not.toContain("OLD SETUP TIMEOUT");
});

it("removes runtime ready from chat after a shared owner invalidation", async () => {
  vi.mocked(chatViewLogic.scheduleEnvironmentReconnectWarning).mockImplementation((show) => {
    show();
    return () => {};
  });
  const registry = AtomRegistry.make();
  const identity = { supervisorId: "chat-owner", attemptId: 2, routeId: "ssh:fixture" };
  const status = {
    host: "fixture",
    state: "ready",
    runtimeVersion: null,
    requestedVersion: "1.0.0",
  } as const;
  const runtimeStatus = Atom.make<SshHostStatus | undefined>(undefined);
  const snapshot = {
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connecting",
    stage: "opening",
    attempt: 2,
    lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "SETUP TIMEOUT" }),
    failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
    sshRuntimeReady: {
      ...identity,
      operationId: "op",
      attachmentId: "attachment",
      runtimeStatus: status,
    },
  } as const;
  const projections = createEnvironmentPresentationAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([[local, { ...entry, enabled: true }]]),
    }),
    stateAtom: () => Atom.make(AsyncResult.success(snapshot)),
    serverConfigValueAtom: () => Atom.make(null),
    sshRuntimeStatusAtom: () => runtimeStatus,
  });
  const atom = projections.presentationAtom(local);
  const stop = registry.subscribe(atom, () => {});
  const draw = async () => {
    state.primaryConnection = registry.get(atom)!.connection;
    await act(async () => root.render(<div />));
    await mount();
  };
  const banner = () => container.querySelector('[data-banner^="environment-unavailable:"]');
  try {
    await draw();
    expect(banner()?.textContent).toContain("Runtime ready · Opening connection");
    for (const state of ["failed", "stopped", "untrusted"] as const) {
      registry.set(runtimeStatus, { ...status, state });
      await draw();
      expect(banner()?.textContent).not.toContain("Runtime ready");
      expect(banner()?.textContent).toContain("SETUP TIMEOUT");
    }
  } finally {
    stop();
    registry.dispose();
  }
});
