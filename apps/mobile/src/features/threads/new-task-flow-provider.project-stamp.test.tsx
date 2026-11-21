import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { EnvironmentRegistry } from "@goat/client-runtime/connection";
import { createEnvironmentSubscriptionAtomFamily } from "@goat/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectId,
  type VcsListRefsResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ComposerDraft } from "../../state/use-composer-drafts";

const mocks = vi.hoisted(() => ({
  projects: vi.fn(),
  status: vi.fn(),
  refs: vi.fn(),
  readFile: vi.fn(),
  session: vi.fn(),
  presentation: vi.fn(),
  registry: vi.fn(),
  drafts: vi.fn(),
  snapshot: vi.fn(),
  createDraft: vi.fn(),
  retargetDraft: vi.fn(),
  writeSettings: vi.fn(),
  writeText: vi.fn(),
  alert: vi.fn(),
  queued: vi.fn(),
  flushWrite: vi.fn(),
  release: vi.fn(),
  clearDraft: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => mocks.registry().get(atom),
    set: (atom: Atom.Writable<unknown, unknown>, value: unknown) =>
      mocks.registry().set(atom, value),
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: mocks.projects,
  useThreadShells: () => [],
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: mocks.status, listRefs: mocks.refs },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: mocks.readFile, openScratch: {} },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: mocks.session },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: mocks.presentation,
}));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("../../state/olderSettledShelf", () => ({ useOlderSettledCount: () => 0 }));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "none" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/use-model-option-memory", () => ({
  rememberModelOptions: vi.fn(),
  withRememberedModelOptions: (value: unknown) => value,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerDraftsLoadedAtom: Atom.make(true),
  useComposerDraft: mocks.drafts,
  getComposerDraftSnapshot: mocks.snapshot,
  createNewTaskDraft: mocks.createDraft,
  retargetNewTaskDraft: mocks.retargetDraft,
  updateComposerDraftSettings: mocks.writeSettings,
  setComposerDraftText: mocks.writeText,
  useStickyComposerModelSelection: () => null,
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  clearComposerDraft: mocks.clearDraft,
  appendComposerDraftAttachments: vi.fn(),
  removeComposerDraftAttachment: vi.fn(),
  replaceComposerDraftAttachments: vi.fn(),
  setStickyComposerModelSelection: vi.fn(),
  setComposerDraftContext: vi.fn(),
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  isComposerDraftEmpty: (draft: ComposerDraft) =>
    draft.text === "" && draft.attachments.length === 0,
}));

vi.mock("../../lib/useThreadContextHosts", () => ({ useThreadContextHosts: () => new Map() }));
vi.mock("../../state/thread-outbox", () => ({
  flattenQueuedThreadMessages: () => mocks.queued() ?? [],
  threadOutboxManager: { queuedMessagesByThreadKeyAtom: Atom.make({}) },
}));
vi.mock("../../state/use-thread-outbox", () => ({
  holdEditingQueuedMessage: vi.fn(),
  releaseEditingQueuedMessage: mocks.release,
  useThreadOutboxMessages: () => [],
}));
vi.mock("../../state/pending-task-editor-writes", () => ({
  capturePendingTaskEditorWriteBaseline: vi.fn(),
  flushPendingTaskEditorWrite: mocks.flushWrite,
}));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../../state/project-has-threads", () => ({ useProjectHasThreads: () => false }));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => true,
  useWorkspaceEnvironments: () => [],
}));
vi.mock("../../state/shell", () => ({ useEnvironmentShellReadiness: () => ({}) }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));

import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";

function project(environment: string, id: string): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  const registry = AtomRegistry.make();
  mocks.registry.mockReturnValue(registry);
  const projects = [project("one", "a"), project("one", "b"), project("two", "b")];
  mocks.projects.mockReturnValue(projects);
  mocks.presentation.mockReturnValue({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  });
  const events: string[] = [];
  let checkout = "main";
  let checkoutIsRepo = true;
  let holdStatus = false;
  const emitters = new Map<string, (branch: string, isRepo?: boolean) => void>();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      followStream: (_environmentId, source) => source,
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const status = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "test:new-task-status",
    idleTtlMs: 10_000,
    subscribe: ({ cwd }: { cwd: string }) =>
      Stream.callback<{ refName: string; isRepo: boolean }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push(`start:${cwd}`);
            const emit = (refName: string, isRepo = true) =>
              void Queue.offerUnsafe(queue, { refName, isRepo });
            emitters.set(cwd, emit);
            if (!holdStatus) emit(checkout, checkoutIsRepo);
          }),
          () => Effect.sync(() => void events.push(`stop:${cwd}`)),
        ),
      ),
  });
  mocks.status.mockImplementation(status);
  const refs = Atom.family((key: string) =>
    Atom.make(() => {
      const [, cwd] = JSON.parse(key) as [string, string];
      const result: VcsListRefsResult = {
        refs: [{ name: "main", current: true, isDefault: true, worktreePath: cwd }],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      };
      return AsyncResult.success(result);
    }).pipe(Atom.keepAlive),
  );
  mocks.refs.mockImplementation(({ environmentId, input }) =>
    refs(JSON.stringify([environmentId, input.cwd])),
  );
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
  );
  mocks.session.mockReturnValue(session);
  const file = Atom.make(AsyncResult.success({ exists: true, contents: "{}" }));
  mocks.readFile.mockReturnValue(file);

  const empty: ComposerDraft = { text: "", attachments: [] };
  const drafts = Atom.make<Record<string, ComposerDraft>>({}).pipe(Atom.keepAlive);
  const snapshot = (key: string | null): ComposerDraft =>
    (key === null ? undefined : registry.get(drafts)[key]) ?? empty;
  const write = (key: string, patch: Partial<ComposerDraft>) =>
    registry.set(drafts, { ...registry.get(drafts), [key]: { ...snapshot(key), ...patch } });
  mocks.drafts.mockImplementation((key: string | null) => {
    const all = useAtomValue(drafts);
    return (key === null ? undefined : all[key]) ?? empty;
  });
  mocks.snapshot.mockImplementation(snapshot);
  mocks.createDraft.mockImplementation((target) => {
    const key = `new-task:${Object.keys(registry.get(drafts)).length}`;
    write(key, { project: target });
    return key;
  });
  mocks.retargetDraft.mockImplementation((key, target) =>
    write(key, { project: target, workspaceSelection: undefined }),
  );
  mocks.writeSettings.mockImplementation(write);
  mocks.writeText.mockImplementation((key, text) => write(key, { text }));
  let current: ReturnType<typeof useNewTaskFlow>;
  function Probe(props: { pickOnMount: EnvironmentProject }) {
    const value = useNewTaskFlow();
    useLayoutEffect(() => {
      current = value;
    });
    useEffect(() => {
      value.setProject(props.pickOnMount);
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- simulate a route selection once on mount
    }, []);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    projects,
    events,
    checkout(branch: string, isRepo = true) {
      checkout = branch;
      checkoutIsRepo = isRepo;
    },
    holdStatus() {
      holdStatus = true;
    },
    offline() {
      mocks.presentation.mockReturnValue({
        isReady: true,
        presentation: { connection: { phase: "offline", error: null } },
      });
      holdStatus = true;
    },
    snapshot,
    clearWorkspace(key: string) {
      act(() => write(key, { workspaceSelection: undefined }));
    },
    get current() {
      return current;
    },
    async render(active: boolean) {
      await act(async () =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <NewTaskFlowProvider active={active} flowKey="test-flow">
              <Probe pickOnMount={projects[2]!} />
            </NewTaskFlowProvider>
          </RegistryContext.Provider>,
        ),
      );
    },
    async emit(cwd: string, branch: string, isRepo = true) {
      await act(async () => emitters.get(cwd)!(branch, isRepo));
    },
    async expireIdle() {
      await act(async () => vi.advanceTimersByTime(11_000));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
      vi.useRealTimers();
    },
  };
}

it("keeps the project chosen by the screen on mount in the draft stamp", async () => {
  using screen = setup();
  await screen.render(true);
  expect(screen.current.selectedProject).toEqual(screen.projects[2]);
  expect(screen.snapshot(screen.current.draftKey).project).toEqual({
    environmentId: "two",
    projectId: "b",
  });
});
