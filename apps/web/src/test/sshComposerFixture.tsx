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
  type ResolvedKeybindingsConfig,
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
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
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
  // Per-test query data by atom; null keeps every query empty.
  queryData: null as ((atom: unknown) => unknown) | null,
  narrowRightPanel: false,
  keybindings: null as ResolvedKeybindingsConfig | null,
  // Stable like the real store selectors; a fresh array per render loops the timeline.
  empty: [] as never[],
}));
export { state };
// Browser importActual resolves shared helpers from a URL; root paths keep those mocks resolvable.
vi.mock("/src/components/ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (v: unknown) => v,
}));
vi.mock("@tanstack/react-router", { spy: true });
vi.mock("/src/hooks/useSettings", { spy: true });
vi.mock("/src/hooks/useTheme", { spy: true });
vi.mock("/src/hooks/useThreadActions", { spy: true });
vi.mock("/src/state/session", { spy: true });
vi.mock("/src/state/query", { spy: true });
vi.mock("/src/state/terminalSessions", { spy: true });
vi.mock("/src/state/projectClones", { spy: true });
vi.mock("/src/state/device", { spy: true });
vi.mock("/src/state/environments", { spy: true });
vi.mock("/src/state/entities", { spy: true });
vi.mock("/src/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    state.narrowRightPanel && query === RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
}));
vi.mock("/src/hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("/src/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
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
vi.mock("/src/hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({ refresh: () => {}, pending: false, environmentId: null }),
}));
vi.mock("/src/hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("/src/remoteOpen", { spy: true });
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
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { vcsEnvironment } from "~/state/vcs";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  environmentServerConfigsAtom,
} from "~/state/server";
import * as router from "@tanstack/react-router";
import * as settings from "~/hooks/useSettings";
import * as theme from "~/hooks/useTheme";
import * as threadActions from "~/hooks/useThreadActions";
import * as session from "~/state/session";
import * as query from "~/state/query";
import * as terminalSessions from "~/state/terminalSessions";
import * as projectClones from "~/state/projectClones";
import * as device from "~/state/device";
import * as environments from "~/state/environments";
import * as entities from "~/state/entities";
import * as remoteOpen from "~/remoteOpen";
state.registry = appAtomRegistry;
// Store snapshots must be stable, or useSyncExternalStore re-renders forever.
const noEditors: never[] = [];
const noServerConfigs = new Map();
// Spy-mode mocks keep the real modules; these overrides replace only what the fixture controls.
function overrideModuleSpies() {
  vi.mocked(router.useRouter).mockReturnValue({
    latestLocation: { pathname: "/", state: {} },
  } as never);
  vi.mocked(router.useNavigate).mockReturnValue(state.navigate);
  vi.mocked(router.useLocation).mockImplementation((({
    select,
  }: {
    select: (v: unknown) => unknown;
  }) => select({ href: "/", state: {} })) as never);
  vi.mocked(router.useParams).mockReturnValue({} as never);
  vi.mocked(settings.useEnvironmentSettings).mockImplementation(
    () =>
      ({
        ...DEFAULT_SERVER_SETTINGS,
        ...DEFAULT_CLIENT_SETTINGS,
        ...(state.data!.realComposer
          ? { providerInstances: { antigravity: { driver: "antigravity", enabled: true } } }
          : {}),
      }) as never,
  );
  vi.mocked(settings.useEnvironmentIdentificationMode).mockReturnValue("none" as never);
  vi.mocked(settings.useClientSettings).mockImplementation(((
    select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown,
  ) => (select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS)) as never);
  vi.mocked(settings.useClientSettingsHydrated).mockReturnValue(true);
  vi.mocked(theme.useTheme).mockReturnValue({ resolvedTheme: "light" } as never);
  vi.mocked(theme.useRenderedAppearance).mockReturnValue("light" as never);
  vi.mocked(threadActions.useThreadActions).mockReturnValue({} as never);
  vi.mocked(threadActions.useAcknowledgeThreadWoke).mockReturnValue(vi.fn() as never);
  vi.mocked(session.useEnvironmentScope).mockReturnValue(true as never);
  vi.mocked(session.readEnvironmentScope).mockReturnValue(true as never);
  vi.mocked(session.readPreparedConnection).mockReturnValue(Option.none() as never);
  vi.mocked(query.useEnvironmentQuery).mockImplementation(((atom: unknown) => ({
    data: state.queryData?.(atom) ?? null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => {},
  })) as never);
  vi.mocked(terminalSessions.useKnownTerminalSessions).mockReturnValue(null as never);
  vi.mocked(terminalSessions.useThreadRunningTerminalIds).mockReturnValue([] as never);
  vi.mocked(projectClones.useProjectClone).mockReturnValue(null as never);
  vi.mocked(device.useDeviceState).mockReturnValue({
    state: { onboardingCompleted: false, hosts: [], sessions: {} },
    isReady: true,
  } as never);
  vi.mocked(environments.useEnvironments).mockImplementation(
    () =>
      ({
        environments: [
          state.primaryConnection
            ? { ...state.data!.primary, connection: state.primaryConnection }
            : state.data!.primary,
        ],
      }) as never,
  );
  vi.mocked(environments.usePrimaryEnvironment).mockImplementation(
    () => state.data!.primary as never,
  );
  vi.mocked(environments.usePrimaryEnvironmentId).mockReturnValue(local as never);
  vi.mocked(environments.useEnvironment).mockImplementation(() => state.data!.primary as never);
  vi.mocked(environments.useEnvironmentProviders).mockImplementation(
    () => new Map([[local, state.data!.primary.serverConfig?.providers ?? []]]) as never,
  );
  vi.mocked(entities.useProject).mockImplementation(() => state.data!.project as never);
  vi.mocked(entities.useProjects).mockImplementation(() => [state.data!.project] as never);
  vi.mocked(entities.useThreadShell).mockReturnValue(null as never);
  vi.mocked(entities.useThreadProjection).mockReturnValue(null as never);
  vi.mocked(entities.useThreadStatus).mockReturnValue(null as never);
  vi.mocked(entities.useThreadHistory).mockReturnValue({ hasMoreHistory: false } as never);
  vi.mocked(entities.useThreadVisibleTurnItems).mockReturnValue(state.empty);
  vi.mocked(entities.useThreadCheckpointSummaries).mockReturnValue(state.empty);
  vi.mocked(entities.useThreadRefs).mockReturnValue(state.empty);
  vi.mocked(entities.useEnvironmentThreadRefs).mockReturnValue(state.empty);
  vi.mocked(entities.useChildThreadInputs).mockReturnValue(state.empty);
  vi.mocked(entities.useEnvironmentSupportsServerBrowser).mockReturnValue(false);
  vi.mocked(entities.resolveThreadDetailRef).mockReturnValue(null as never);
  vi.mocked(entities.waitForThreadShell).mockImplementation(((...args: unknown[]) =>
    state.shell(...args)) as never);
  vi.mocked(remoteOpen.useRemoteOpenState).mockReturnValue({} as never);
}
// Loaded here, after the mocks above and outside any test, so the first test does not spend its
// timeout importing the chat view graph on a busy CI runner.
const { ThreadRouteView } = await import("~/components/ThreadRouteView");
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
  overrideModuleSpies();
  state.primaryConnection = null;
  state.queryData = null;
  state.narrowRightPanel = false;
  state.keybindings = null;
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
  // The registry outlives one test, and a test that times out never disposes. Unwrap a spy it
  // left behind so this one wraps the real get instead of recursing through the old spy.
  if (vi.isMockFunction(registry.get)) registry.get.mockRestore();
  const get = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((atom: Atom.Atom<unknown>) =>
    atom === environmentCatalog.catalogValueAtom
      ? state.data!.catalog
      : atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)
        ? true
        : atom === primaryServerAvailableEditorsAtom
          ? noEditors
          : atom === primaryServerKeybindingsAtom
            ? (state.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS)
            : atom === environmentServerConfigsAtom
              ? noServerConfigs
              : get(atom)) as typeof registry.get);
  // This fixture supplies navigation directly; the router would add an unrelated route context.
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
