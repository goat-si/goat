import type { ComponentProps, ReactNode } from "react";
import { vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type SshWorkspaceLaunchResult,
} from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { createModelSelection } from "@goat/shared/model";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import { act, render, stubGlobal } from "../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import type { ChatComposer } from "~/components/chat/ChatComposer";
const state = vi.hoisted(() => ({
  data: null as ReturnType<typeof createSshData> | null,
  noopCommand: vi.fn(),
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
export { state };
// Browser importActual resolves shared helpers from a URL; root paths keep those mocks resolvable.
vi.mock("/src/components/ui/toast", () => ({
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
vi.mock("/src/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...DEFAULT_CLIENT_SETTINGS,
    ...(state.data!.realComposer
      ? { providerInstances: { antigravity: { driver: "antigravity", enabled: true } } }
      : {}),
  }),
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: (select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
}));
vi.mock("/src/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("/src/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
  useRenderedAppearance: () => "light",
}));
vi.mock("/src/hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("/src/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("/src/hooks/useThreadActions", async (original) => ({
  ...(await original<typeof import("~/hooks/useThreadActions")>()),
  useThreadActions: () => ({}),
  useAcknowledgeThreadWoke: () => vi.fn(),
}));
vi.mock("/src/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  readPreparedConnection: () => Option.none(),
}));
vi.mock("/src/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: () => ({
    data: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("/src/state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.normal,
}));
vi.mock("/src/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.uploads }));
vi.mock("/src/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === vcsEnvironment.sshWorkspaceLaunch
      ? state.launch
      : command === environmentCatalog.retryNow
        ? state.retry
        : state.noopCommand,
}));
vi.mock("/src/state/terminalSessions", async (original) => ({
  ...(await original<typeof import("~/state/terminalSessions")>()),
  useKnownTerminalSessions: () => null,
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("/src/state/projectClones", async (original) => ({
  ...(await original<typeof import("~/state/projectClones")>()),
  useProjectClone: () => null,
}));
vi.mock("/src/state/device", async (original) => ({
  ...(await original<typeof import("~/state/device")>()),
  useDeviceState: () => ({
    state: { onboardingCompleted: false, hosts: [], sessions: {} },
    isReady: true,
  }),
}));
vi.mock("/src/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironments: () => ({
    environments: [
      state.primaryConnection
        ? { ...state.data!.primary, connection: state.primaryConnection }
        : state.data!.primary,
    ],
  }),
  usePrimaryEnvironment: () => state.data!.primary,
  usePrimaryEnvironmentId: () => local,
  useEnvironment: () => state.data!.primary,
  useEnvironmentProviders: () =>
    new Map([[local, state.data!.primary.serverConfig?.providers ?? []]]),
}));
vi.mock("/src/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useProject: () => state.data!.project,
  useProjects: () => [state.data!.project],
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
vi.mock("/src/hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({ refresh: () => {}, pending: false, environmentId: null }),
}));
vi.mock("/src/hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("/src/remoteOpen", async (original) => ({
  ...(await original<typeof import("~/remoteOpen")>()),
  useRemoteOpenState: () => ({}),
}));
vi.mock("/src/components/chat/useAutoBalanceUpdateBanner", () => ({
  useAutoBalanceUpdateBanner: () => null,
}));
vi.mock("/src/components/ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
}));
vi.mock("/src/components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("/src/components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("/src/components/chat/ThreadDetailsPanel", () => ({ ThreadDetailsPanel: () => null }));
vi.mock("/src/components/chat/DraftHeroHeadline", () => ({ DraftHeroHeadline: () => null }));
vi.mock("/src/components/chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: () => null,
  ExpandedImageDialogHost: () => null,
  openExpandedImagePreview: () => {},
}));
vi.mock("/src/components/PullRequestThreadDialog", () => ({ PullRequestThreadDialog: () => null }));
vi.mock("/src/components/ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("/src/components/ui/sidebar", () => ({
  useSidebar: () => ({ state: "expanded", isMobile: false }),
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
// Browser mocks snapshot exports; forward method reads to the registry under test.
vi.mock("/src/rpc/atomRegistry", async (original) => {
  const actual = await original<typeof import("~/rpc/atomRegistry")>();
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
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { vcsEnvironment } from "~/state/vcs";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  environmentServerConfigsAtom,
} from "~/state/server";
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: Atom.Atom<unknown>) => {
      if (atom === environmentCatalog.catalogValueAtom) return state.data!.catalog;
      if (atom === primaryServerAvailableEditorsAtom) return [];
      if (atom === primaryServerKeybindingsAtom) return DEFAULT_RESOLVED_KEYBINDINGS;
      if (atom === environmentServerConfigsAtom) return new Map();
      if (atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)) return true;
      return actual.useAtomValue(atom);
    },
  };
});
export const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
export const destination = { connectionId: "saved", environmentId: remote };
export const entry = {
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
export const id = DraftId.make("A");
export const store = () => useComposerDraftStore.getState();
export const result: SshWorkspaceLaunchResult = {
  operationId: "12345678",
  snapshotRef: "ref",
  snapshotOid: "oid",
  remoteEnvironmentId: remote,
  remoteProjectId: ProjectId.make("remote-project"),
  remoteThreadId: ThreadId.make("remote-thread"),
  remoteRepoPath: "/remote",
  branch: "branch",
};
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function createSshData(realComposer: boolean) {
  const selection = createModelSelection(
    ProviderInstanceId.make(realComposer ? "antigravity" : "codex"),
    "model",
  );
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
  const provider: ServerProvider = {
    driver: ProviderDriverKind.make("antigravity"),
    instanceId: ProviderInstanceId.make("antigravity"),
    enabled: true,
    installed: false,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-01-01T00:00:00Z",
    models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  const primary = {
    environmentId: local,
    label: "Local",
    entry: { target: { _tag: "PrimaryConnectionTarget" } },
    connection: { phase: "connected" },
    serverConfig: realComposer
      ? {
          providers: [provider],
          environment: { capabilities: {}, platform: { machine: "mac" } },
        }
      : null,
  };
  return {
    realComposer,
    selection,
    project,
    primary,
    catalog: { isReady: true, entries: new Map([[remote, entry]]) },
  };
}
export async function setupSshComposer(realComposer = false) {
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const { selection, project, primary } = (state.data = createSshData(realComposer));
  state.primaryConnection = null;
  state.noopCommand.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [] } });
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
  stack.use(stubGlobal("desktopBridge", { onMenuAction: () => () => {} }));
  vi.spyOn(document, "fonts", "get").mockReturnValue(new EventTarget() as FontFaceSet);
  state.composer = null;
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

  state.shell.mockReset().mockResolvedValue(true);
  state.retry.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.normal.mockReset();
  state.uploads.mockReset();
  state.toast.mockReset();
  if (realComposer) {
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList,
    );
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 1, 1),
    );
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.stubGlobal("scrollBy", () => {});
  }
  const registry = state.registry!;
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((atom: Atom.Atom<unknown>) =>
    atom === environmentCatalog.catalogValueAtom
      ? state.data!.catalog
      : atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)
        ? true
        : get(atom)) as typeof registry.get);
  // Navigation hooks are mocked so both lanes can control completion and remounts.
  const { ThreadRouteView } = await import("~/components/ThreadRouteView");
  const screen = stack.use(await render(<div />, { router: false }));
  stack.defer(() => act(() => state.composer?.onMultipleModelSelectionsChange(null)));
  state.navigate.mockReset().mockImplementation(async (request) => {
    if (request.to === "/$environmentId/$threadId")
      await screen.rerender(<div data-remote-thread={request.params.threadId} />);
  });
  const mount = (draftId = id) =>
    screen.rerender(
      <AppAtomRegistryProvider>
        <ThreadRouteView target={{ kind: "draft", draftId }} />
      </AppAtomRegistryProvider>,
    );
  const owned = stack.move();
  return {
    mount,
    container: screen.container,
    rerender: screen.rerender,
    selection,
    project,
    primary,
    catalog: state.data.catalog,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
