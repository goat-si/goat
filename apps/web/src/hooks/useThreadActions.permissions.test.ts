import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "@goat/client-runtime/environment";
import { useDiffPanelStore } from "../diffPanelStore";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { useRightPanelStore } from "../rightPanelStore";
import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    sideChatOf?: ThreadId | null;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
  worktreeManaged: true as boolean | undefined,
  worktreeRemovalGuarded: true as boolean | undefined,
  holderTitles: {} as Record<string, string>,
  worktreeThreadIds: [] as ThreadId[],
}));

vi.mock("gt-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("gt-react")>();
  return { ...actual, useGT: () => actual.gtFallback };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    state: { location: { href: "/" }, matches: [] },
    history: { subscribe: () => () => {} },
    navigate: async () => {},
  }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (query: unknown) =>
    query === "session"
      ? loadSession
      : query === orchestrationEnvironment.threadTitleLookup
        ? loadHolderTitles
        : loadWorktreeThreadIds,
}));
const loadHolderTitles = async () => AsyncResult.success({ lookupTitles: state.holderTitles });
const loadWorktreeThreadIds = async () =>
  AsyncResult.success({
    threadIds: state.worktreeThreadIds.length > 0 ? state.worktreeThreadIds : [target.threadId],
    ...(state.worktreeManaged === undefined ? {} : { managed: state.worktreeManaged }),
    ...(state.worktreeRemovalGuarded === undefined
      ? {}
      : { removalGuarded: state.worktreeRemovalGuarded }),
  });
const loadSession = async (environmentId: string) =>
  state.sessionLookupFails
    ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
    : AsyncResult.success({
        authenticated: true,
        scopes: [...(state.scopes.get(environmentId) ?? [])],
        auth: { serverUpdateScope: "environment:maintain" },
      });
vi.mock("../components/sidebar/usePaletteVisibility", () => ({
  usePaletteHiddenParentKeys: () => new Set<string>(),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "./useThreadActions";

function seedThreadPanelState(ref: ScopedThreadRef) {
  useRightPanelStore.getState().show(ref);
  useDiffPanelStore.getState().selectGitScope(ref, "branch");
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab"));
}

function threadPanelStatePresence(ref: ScopedThreadRef) {
  const key = scopedThreadKey(ref);
  return {
    rightPanel: key in useRightPanelStore.getState().byThreadKey,
    diffPanel: key in useDiffPanelStore.getState().byThreadKey,
    miniPlayer: key in usePreviewMiniPlayerStore.getState().byThreadKey,
  };
}
const panelStateKept = { rightPanel: true, diffPanel: true, miniPlayer: true };
const panelStateCleared = { rightPanel: false, diffPanel: false, miniPlayer: false };

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  state.worktreeManaged = true;
  state.worktreeRemovalGuarded = true;
  state.holderTitles = {};
  state.worktreeThreadIds = [];
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
  usePreviewMiniPlayerStore.setState(usePreviewMiniPlayerStore.getInitialState(), true);
});

describe("thread action permissions", () => {
  it("keeps the worktree when an old server becomes guarded after confirmation", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.worktreeRemovalGuarded = undefined;
    state.confirm.mockImplementation(async () => {
      state.worktreeRemovalGuarded = true;
      return true;
    });
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
  });
  it("discloses automatic cleanup for an older server and does not request removal", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.worktreeRemovalGuarded = undefined;
    const get = appAtomRegistry.get.bind(appAtomRegistry);
    using _get = vi.spyOn(appAtomRegistry, "get").mockImplementation(((atom: unknown) =>
      atom === environmentServerConfigsAtom
        ? new Map([
            [
              secondary,
              {
                settings: {
                  ...DEFAULT_SERVER_SETTINGS,
                  storageCleanup: {
                    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
                    worktreeOnDelete: true,
                  },
                },
              },
            ],
          ])
        : get(atom as never)) as never);
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "The server's automatic cleanup setting may still remove the worktree.",
      ),
      { variant: "destructive" },
    );
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
  });
  it("names an archived worktree holder absent from the client shell", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    const archived = ThreadId.make("archived-holder");
    state.worktreeThreadIds = [target.threadId, archived];
    state.holderTitles = { [archived]: "Archived analysis" };
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Archived analysis"), {
      variant: "destructive",
    });
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
  });
  it("limits named worktree holders and reports the remaining count", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    const ids = Array.from({ length: 8 }, (_, index) => ThreadId.make(`holder-${index}`));
    state.worktreeThreadIds = [target.threadId, ...ids];
    state.holderTitles = Object.fromEntries(ids.map((id, index) => [id, `Holder ${index}`]));
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    const message = state.confirm.mock.calls[0]![0];
    expect(message).toContain("Holder 0");
    expect(message).toContain("Holder 4");
    expect(message).not.toContain("Holder 5");
    expect(message).toContain("and 3 more");
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
  });
  it.each([false, undefined])(
    "keeps the worktree and tells the user when the server guard is %s",
    async (guarded) => {
      state.scopes
        .get(secondary)!
        .add(AuthOrchestrationOperateScope)
        .add(AuthSourceControlWriteScope);
      state.threads[0]!.worktreePath = "/worktrees/thread";
      state.worktreeRemovalGuarded = guarded;
      expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
      expect(state.confirm).toHaveBeenCalledWith(
        expect.stringContaining("The worktree will be kept."),
        { variant: "destructive" },
      );
      expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
    },
  );
  it("offers worktree cleanup when the deleted thread is its last holder", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.worktreeThreadIds = [target.threadId];
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Delete the worktree too?"),
      { variant: "destructive" },
    );
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(true);
  });
  it("names a side chat that keeps the worktree when its parent is deleted", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    const sideId = ThreadId.make("side-chat");
    state.threads.push({
      environmentId: secondary,
      id: sideId,
      projectId: ProjectId.make("project"),
      title: "Side question",
      sideChatOf: target.threadId,
      worktreePath: "/worktrees/thread",
      session: null,
      latestTurn: null,
    });
    state.worktreeThreadIds = [target.threadId, sideId];
    expect((await useThreadActions().confirmAndDeleteThread(target))._tag).toBe("Success");
    expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining("Side question"), {
      variant: "destructive",
    });
    expect(state.requests.some((request) => request.action === "removeWorktree")).toBe(false);
  });
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("names an archived thread in its delete confirmation and preserves it on cancel", async () => {
    state.threads = [];
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.confirm.mockResolvedValue(false);
    await useThreadActions().confirmAndDeleteThread(target, "Archived release notes");
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete thread "Archived release notes"?'),
      { variant: "destructive" },
    );
    expect(state.requests).toEqual([]);
  });

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    seedThreadPanelState(target);
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
    expect(state.localEffects).toEqual([
      "refresh-archive",
      "release-uploads",
      "clear-draft",
      "clear-terminal-ui",
    ]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    { reason: "outside GOAT's worktrees folder", managed: false },
    { reason: "when an older server cannot say who made it", managed: undefined },
  ])("deletes a thread without offering its worktree $reason", async ({ managed }) => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    // An imported session records the user's own checkout as its thread's worktree.
    state.threads[0]!.worktreePath = "/Users/me/own-checkout";
    state.worktreeManaged = managed;
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
  });

  it("offers and removes a worktree GOAT made", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Delete the worktree too?"),
      {
        variant: "destructive",
      },
    );
    expect(state.requests.map((request) => request.action)).toEqual([
      "stopSession",
      "delete",
      "removeWorktree",
      "refreshStatus",
    ]);
  });
});
