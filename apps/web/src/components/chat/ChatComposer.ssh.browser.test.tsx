import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
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
import { SshConnectionProfile, SshConnectionTarget } from "@goat/client-runtime/connection";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { ChatComposer } from "./ChatComposer";
const state = vi.hoisted(() => ({
  noopCommand: vi.fn(async () => ({ _tag: "Success", value: { providers: [] } })),
  registry: null as import("effect/reactivity").AtomRegistry.AtomRegistry | null,
  launch: vi.fn(),
  navigate: vi.fn(),
  retry: vi.fn(),
  normal: vi.fn(),
  uploads: vi.fn(),
  toast: vi.fn(),
  shell: vi.fn(),
  composer: null as ComponentProps<typeof ChatComposer> | null,
  // Stable like the real store selectors; a fresh array per render loops the timeline.
  empty: [] as never[],
}));
vi.mock("../ui/toast", () => ({
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
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...DEFAULT_CLIENT_SETTINGS,
    providerInstances: { antigravity: { driver: "antigravity", enabled: true } },
  }),
  useClientSettings: (select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
  useRenderedAppearance: () => "light",
}));
vi.mock("../../hooks/useRemoveClonedProject", () => ({ useRemoveClonedProject: () => vi.fn() }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../hooks/useThreadActions", async (original) => ({
  ...(await original<typeof import("../../hooks/useThreadActions")>()),
  useThreadActions: () => ({}),
  useAcknowledgeThreadWoke: () => vi.fn(),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  readPreparedConnection: () => Option.none(),
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({
    data: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.normal,
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.uploads }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === vcsEnvironment.sshWorkspaceLaunch
      ? state.launch
      : command === environmentCatalog.retryNow
        ? state.retry
        : state.noopCommand,
}));
vi.mock("../../state/terminalSessions", async (original) => ({
  ...(await original<typeof import("../../state/terminalSessions")>()),
  useKnownTerminalSessions: () => null,
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("../../state/projectClones", async (original) => ({
  ...(await original<typeof import("../../state/projectClones")>()),
  useProjectClone: () => null,
}));
vi.mock("../../state/device", async (original) => ({
  ...(await original<typeof import("../../state/device")>()),
  useDeviceState: () => ({
    state: { onboardingCompleted: false, hosts: [], sessions: {} },
    isReady: true,
  }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [primary] }),
  useEnvironmentProviders: () => new Map([[local, primary.serverConfig.providers]]),
  usePrimaryEnvironment: () => primary,
  usePrimaryEnvironmentId: () => local,
  useEnvironment: () => primary,
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
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
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({ refresh: () => {}, pending: false, environmentId: null }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("../../remoteOpen", async (original) => ({
  ...(await original<typeof import("../../remoteOpen")>()),
  useRemoteOpenState: () => ({}),
}));
vi.mock("./useAutoBalanceUpdateBanner", () => ({ useAutoBalanceUpdateBanner: () => null }));
vi.mock("../ThreadStatusIndicators", () => ({ useLinkedThreadPullRequest: () => null }));
vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./ThreadDetailsPanel", () => ({ ThreadDetailsPanel: () => null }));
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./DraftHeroHeadline", () => ({ DraftHeroHeadline: () => null }));
vi.mock("./ExpandedImageDialog", () => ({
  ExpandedImageDialog: () => null,
  ExpandedImageDialogHost: () => null,
  openExpandedImagePreview: () => {},
}));
vi.mock("../PullRequestThreadDialog", () => ({ PullRequestThreadDialog: () => null }));
vi.mock("../ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ state: "expanded", isMobile: false }),
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ChatComposer", async (original) => {
  const actual = await original<typeof import("./ChatComposer")>();
  return {
    ...actual,
    ChatComposer: (props: ComponentProps<typeof actual.ChatComposer>) => {
      state.composer = props;
      return <actual.ChatComposer {...props} />;
    },
  };
});
// Browser mocks snapshot exports; forward method reads to the registry under test.
vi.mock("../../rpc/atomRegistry", async (original) => {
  const actual = await original<typeof import("../../rpc/atomRegistry")>();
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
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import { vcsEnvironment } from "../../state/vcs";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  environmentServerConfigsAtom,
} from "../../state/server";
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
import { ThreadRouteView } from "../ThreadRouteView";
const local = EnvironmentId.make("local"),
  remote = EnvironmentId.make("remote");
const selection = createModelSelection(ProviderInstanceId.make("antigravity"), "model");
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
  connection: { phase: "connected" },
  serverConfig: {
    providers: [provider],
    environment: { capabilities: {}, platform: { machine: "mac" } },
  },
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
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(0, 0, 1, 1)],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 1, 1),
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { onMenuAction: () => () => {} },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("scrollBy", () => {});
  Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
  primary.serverConfig.providers = [provider];
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

const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
it.each(["button", "keyboard"])(
  "allows an SSH %s send with a source-specific provider block",
  async (activation) => {
    await mount();
    expect(submitButton().disabled).toBe(false);
    expect(state.composer!.composerRef.current!.getSendContext().providerAvailable).toBe(true);
    await act(async () => {
      if (activation === "button") submitButton().click();
      else
        container
          .querySelector('[contenteditable="true"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
    });
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("retains the ordinary source-specific provider send block", async () => {
  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  await mount();
  expect(submitButton().disabled).toBe(true);
  expect(submitButton().getAttribute("aria-label")).toBe(
    "Install Antigravity in provider settings before sending.",
  );
  await act(async () => submitButton().click());
  expect(state.launch).not.toHaveBeenCalled();
});
it("keeps typing and paste editable during SSH launch", async () => {
  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  await act(async () => submitButton().click());
  expect(state.composer!.isSendBusy).toBe(true);
  expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  await act(async () => {
    expect(state.composer!.composerRef.current!.insertTextAtEnd(" typed")).toBe(true);
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("typed");
  await act(async () => {
    state.composer!.composerRef.current!.focusAtEnd();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? " pasted" : ""),
      },
    });
    container.querySelector('[contenteditable="true"]')!.dispatchEvent(paste);
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("typed");
  expect(store().getComposerDraft(id)?.prompt).toContain("pasted");
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(store().getComposerDraft(id)?.prompt).toContain("pasted");
});
it.each(["attachment", "fanout", "absent model"])("keeps SSH %s blocked", async (blocker) => {
  if (blocker === "absent model") primary.serverConfig.providers = [];
  await mount();
  await act(async () => {
    if (blocker === "attachment")
      store().addImage(id, {
        id: "image",
        type: "image",
        name: "image",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:image",
        file: new File(["x"], "image"),
      });
    if (blocker === "fanout") state.composer!.onMultipleModelSelectionsChange([]);
  });
  expect(submitButton().disabled).toBe(true);
  if (blocker !== "absent model")
    expect(submitButton().getAttribute("aria-label")).toBe(
      blocker === "attachment"
        ? "Remove attachments before sending to SSH."
        : "Choose one model before sending to SSH.",
    );
  await act(async () => submitButton().click());
  expect(state.launch).not.toHaveBeenCalled();
});
