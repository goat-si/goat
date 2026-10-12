// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
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
} from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { createModelSelection } from "@goat/shared/model";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import { SshConnectionProfile, SshConnectionTarget } from "@goat/client-runtime/connection";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ChatComposer, ChatComposerHandle } from "./chat/ChatComposer";
const state = vi.hoisted(() => ({
  launch: vi.fn(),
  navigate: vi.fn(),
  retry: vi.fn(),
  normal: vi.fn(),
  uploads: vi.fn(),
  toast: vi.fn(),
  shell: vi.fn(),
  composer: null as ComponentProps<typeof ChatComposer> | null,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (v: unknown) => v,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (v: unknown) => unknown }) =>
    select({ href: "/", state: {} }),
  useParams: () => ({}),
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS }),
  useClientSettings: (select?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  useClientSettingsHydrated: () => true,
}));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
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
vi.mock("../state/query", () => ({
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
  useEnvironments: () => ({ environments: [primary] }),
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
  useThreadVisibleTurnItems: () => [],
  useThreadRefs: () => [],
  useEnvironmentThreadRefs: () => [],
  useChildThreadInputs: () => [],
  useEnvironmentSupportsServerBrowser: () => false,
  resolveThreadDetailRef: () => null,
  waitForThreadShell: state.shell,
}));
vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({ turnDiffSummaries: [], setTurnDiffSummaries: () => {} }),
}));
vi.mock("../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({ refresh: () => {}, pending: false, environmentId: null }),
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null, openScratchProject: vi.fn() }),
}));
vi.mock("../remoteOpen", () => ({ useRemoteOpenState: () => ({}) }));
vi.mock("./chat/useAutoBalanceUpdateBanner", () => ({ useAutoBalanceUpdateBanner: () => null }));
vi.mock("./ThreadStatusIndicators", () => ({ useLinkedThreadPullRequest: () => null }));
vi.mock("./chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./chat/ThreadDetailsPanel", () => ({ ThreadDetailsPanel: () => null }));
vi.mock("./chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./chat/DraftHeroHeadline", () => ({ DraftHeroHeadline: () => null }));
vi.mock("./chat/ExpandedImageDialog", () => ({ ExpandedImageDialog: () => null }));
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
          }) as unknown as ChatComposerHandle,
      );
      return (
        <div data-editor="editable">
          <button onClick={() => void props.onSend()}>Send</button>
        </div>
      );
    },
  };
});
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
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
  const get = appAtomRegistry.get.bind(appAtomRegistry);
  vi.spyOn(appAtomRegistry, "get").mockImplementation(((atom: Atom.Atom<unknown>) =>
    atom === environmentCatalog.catalogValueAtom
      ? catalog
      : atom === vcsEnvironment.sshWorkspaceLaunch.permissionAtom(local)
        ? true
        : get(atom)) as typeof appAtomRegistry.get);
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
