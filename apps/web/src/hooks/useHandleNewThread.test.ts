import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ServerSettings,
  type GoatProjectFile,
} from "@goat/contracts";
import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { noteDraftWorkspacePick } from "../lib/draftWorkspacePicks";

const testState = vi.hoisted(() => {
  type Lookup = { known: true; file: GoatProjectFile | null } | { known: false };
  let settleProjectFileRead: (value: Lookup) => void = () => undefined;
  let projectFileRead = Promise.resolve<Lookup>({ known: true, file: null });
  let projectRemoved = false;
  const router = {
    state: { location: { href: "/" }, matches: [{ params: {} as Record<string, string> }] },
    navigate: vi.fn(async (request: { params: { draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
      router.state.matches = [{ params: request.params }];
    }),
  };
  return {
    router,
    settings: {} as { -readonly [K in keyof ServerSettings]: ServerSettings[K] },
    projectDefault: null as "local" | "worktree" | null,
    shellExists: false,
    get projectRemoved() {
      return projectRemoved;
    },
    removeProject() {
      projectRemoved = true;
    },
    restoreProject() {
      projectRemoved = false;
    },
    cachedProjectFile: { known: false } as Lookup,
    get projectFileRead() {
      return projectFileRead;
    },
    /** Settles the background read, then lets the code that waited on it run. */
    async completeProjectFileRead(file: GoatProjectFile | null) {
      settleProjectFileRead({ known: true, file });
      await projectFileRead;
    },
    async failProjectFileRead() {
      settleProjectFileRead({ known: false });
      await projectFileRead;
    },
    defer() {
      projectFileRead = new Promise((resolve) => {
        settleProjectFileRead = resolve;
      });
    },
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.settings,
          newWorktreesStartFromOrigin: !testState.settings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.settings }],
  ]);

vi.mock("../rpc/atomRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rpc/atomRegistry")>();
  const { environmentServerConfigsAtom } = await import("../state/server");
  const get = actual.appAtomRegistry.get.bind(actual.appAtomRegistry);
  return {
    ...actual,
    appAtomRegistry: Object.assign(Object.create(actual.appAtomRegistry), {
      get: (atom: Parameters<typeof get>[0]) =>
        atom === environmentServerConfigsAtom ? testServerConfigs() : get(atom),
    }),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testServerConfigs(),
}));
vi.mock("@goat/shared/projectSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/projectSettings")>()),
  // The new-project rule has its own tests in projectSettings.test.ts.
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../lib/goatProjectFileDefaults", () => ({
  peekGoatProjectFile: () => testState.cachedProjectFile,
  loadGoatProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/utils")>()),
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProject: () => (testState.projectRemoved ? null : { id: "project-remote" }),
  readProjects: () =>
    testState.projectRemoved
      ? []
      : [
          {
            id: "project-remote",
            environmentId: "environment-ssh",
            workspaceRoot: "/remote/project",
            defaultThreadEnvMode: testState.projectDefault,
            defaultModelSelection: null,
          },
        ],
  readThreadShell: () => (testState.shellExists ? {} : null),
  readThreadShells: () => [],
  useProjects: () => [],
  useThreadShell: () => null,
}));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";
const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-ssh"),
  ProjectId.make("project-remote"),
);
const draftId = DraftId.make("draft-existing");
const threadId = ThreadId.make("thread-existing");
const store = () => useComposerDraftStore.getState();
function seed(active = false, fallback = false) {
  store().setLogicalProjectDraftThreadId("remote-project", projectRef, draftId, {
    threadId,
    branch: "old-base",
    worktreePath: "/old/wt",
    envMode: "worktree",
    startFromOrigin: true,
  });
  if (active) {
    testState.router.state.matches = [{ params: { draftId } }];
    testState.router.state.location.href = `/draft/${draftId}`;
  }
  if (fallback)
    useComposerDraftStore.setState({ logicalProjectDraftThreadKeyByLogicalProjectKey: {} });
}
function invest(kind: "text" | "attachment") {
  if (kind === "text") store().setPrompt(draftId, "keep this work");
  else
    store().addImages(draftId, [
      {
        id: "image",
        name: "image.png",
        type: "image",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "data:image/png;base64,AA==",
        file: new File(["x"], "image.png", { type: "image/png" }),
      },
    ]);
}
function expectReset(id = draftId, mode = "local", origin = false) {
  expect(store().getDraftSession(id)).toMatchObject({
    branch: null,
    worktreePath: null,
    envMode: mode,
    startFromOrigin: origin,
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  testState.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    defaultThreadEnvMode: "local",
    defaultRuntimeMode: "full-access",
  };
  testState.projectDefault = null;
  testState.cachedProjectFile = { known: false };
  testState.shellExists = false;
  testState.restoreProject();
  testState.router.state.location.href = "/";
  testState.router.state.matches = [{ params: {} }];
  testState.router.navigate.mockClear();
  testState.defer();
});

describe.each(["new", "stored", "active", "fallback"] as const)(
  "new-thread request with %s draft",
  (path) => {
    const prepare = () => {
      if (path !== "new") seed(path !== "stored", path === "fallback");
    };
    it("resolves fresh workspace defaults without duplicate navigation", async () => {
      prepare();
      const result = await useNewThreadHandler()(projectRef);
      expectReset(result!.draftId);
      expect(testState.router.navigate).toHaveBeenCalledTimes(
        path === "active" || path === "fallback" ? 0 : 1,
      );
    });
    it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
      "uses target permissions %s for new or inactive drafts",
      async (runtimeMode) => {
        prepare();
        testState.settings.defaultRuntimeMode = runtimeMode;
        const result = await useNewThreadHandler()(projectRef);
        expect(store().getDraftSession(result!.draftId)?.runtimeMode).toBe(
          path === "active" || path === "fallback" ? "full-access" : runtimeMode,
        );
      },
    );
    it.each([true, false])("honors target origin default %s", async (origin) => {
      prepare();
      testState.settings.defaultThreadEnvMode = "worktree";
      testState.settings.newWorktreesStartFromOrigin = origin;
      const result = await useNewThreadHandler()(projectRef);
      expectReset(result!.draftId, "worktree", origin);
    });
    it.each([true, false])("honors explicit workspace and origin %s", async (origin) => {
      prepare();
      const options = {
        branch: "explicit",
        worktreePath: "/explicit/wt",
        envMode: "worktree" as const,
        startFromOrigin: origin,
      };
      const result = await useNewThreadHandler()(projectRef, options);
      expect(store().getDraftSession(result!.draftId)).toMatchObject(options);
    });
    it("opens without waiting for the project file", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      // The read never settles, as while a remote environment is still connecting.
      const result = await useNewThreadHandler()(projectRef);
      expectReset(result!.draftId);
      expect(testState.router.navigate).toHaveBeenCalledTimes(
        path === "active" || path === "fallback" ? 0 : 1,
      );
    });
    it("opens with the last known project file", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      testState.settings.newWorktreesStartFromOrigin = true;
      testState.cachedProjectFile = {
        known: true,
        file: { defaultThreadEnvMode: "worktree" } as GoatProjectFile,
      };
      const result = await useNewThreadHandler()(projectRef);
      expectReset(result!.draftId, "worktree", true);
    });
    it("applies a project file default that arrives after opening", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      testState.settings.newWorktreesStartFromOrigin = true;
      const result = await useNewThreadHandler()(projectRef);
      expectReset(result!.draftId, "local", false);
      await testState.completeProjectFileRead({
        defaultThreadEnvMode: "worktree",
      } as GoatProjectFile);
      expectReset(result!.draftId, "worktree", true);
    });
    it("keeps the opened default when the project file read cannot tell", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      testState.cachedProjectFile = {
        known: true,
        file: { defaultThreadEnvMode: "worktree" } as GoatProjectFile,
      };
      const result = await useNewThreadHandler()(projectRef);
      await testState.failProjectFileRead();
      // newWorktreesStartFromOrigin defaults to true.
      expectReset(result!.draftId, "worktree", true);
    });
    it("ignores a late project file once the project is removed", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      const result = await useNewThreadHandler()(projectRef);
      testState.removeProject();
      await testState.completeProjectFileRead({
        defaultThreadEnvMode: "worktree",
      } as GoatProjectFile);
      expect(store().getDraftSession(result!.draftId)?.envMode).toBe("local");
    });
  },
);
it.each([false, true])(
  "keeps absent explicit option keys on reuse with fallback=%s",
  async (fallback) => {
    seed(true, fallback);
    await useNewThreadHandler()(projectRef, { branch: "explicit-base" });
    expect(store().getDraftSession(draftId)).toMatchObject({
      branch: "explicit-base",
      worktreePath: "/old/wt",
      envMode: "worktree",
      startFromOrigin: true,
    });
  },
);
it("restores the absent logical mapping on active fallback", async () => {
  seed(true, true);
  await useNewThreadHandler()(projectRef);
  expectReset();
  expect(store().getDraftSessionByLogicalProjectKey("remote-project")?.draftId).toBe(draftId);
});
it.each(["project", "environment", "file"] as const)(
  "re-resolves %s worktree default",
  async (source) => {
    seed(true);
    testState.settings.newWorktreesStartFromOrigin = true;
    testState.settings.defaultThreadEnvMode = source === "environment" ? "worktree" : null;
    testState.projectDefault = source === "project" ? "worktree" : null;
    await useNewThreadHandler()(projectRef);
    await testState.completeProjectFileRead({
      defaultThreadEnvMode: "worktree",
    } as GoatProjectFile);
    expectReset(draftId, "worktree", true);
  },
);
it.each(["text", "attachment"] as const)(
  "preserves invested %s and opens a fresh default draft",
  async (kind) => {
    seed(true);
    invest(kind);
    const beforeSession = store().getDraftSession(draftId);
    const beforeContent = store().getComposerDraft(draftId);
    const result = await useNewThreadHandler()(projectRef);
    expect(result!.draftId).not.toBe(draftId);
    expectReset(result!.draftId);
    expect(store().getDraftSession(draftId)).toEqual(beforeSession);
    expect(store().getComposerDraft(draftId)).toEqual(beforeContent);
  },
);
it("background follow-up resolves defaults after promotion", async () => {
  seed(true);
  markPromotedDraftThreadByRef(scopeThreadRef(projectRef.environmentId, threadId));
  const result = await useNewThreadHandler()(projectRef);
  expect(result!.draftId).not.toBe(draftId);
  expectReset(result!.draftId);
});
describe.each(["new", "stored", "active", "fallback"] as const)(
  "late project file guards for %s",
  (path) => {
    // Opens provisionally local; the project file then says worktree.
    async function open() {
      if (path !== "new") seed(path !== "stored", path === "fallback");
      testState.settings.defaultThreadEnvMode = null;
      testState.settings.newWorktreesStartFromOrigin = true;
      const result = await useNewThreadHandler()(projectRef);
      return result!.draftId;
    }
    const lateWorktreeDefault = () =>
      testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" } as GoatProjectFile);
    it.each([
      { envMode: "worktree" as const, worktreePath: "/selected/wt" },
      { branch: "selected-base" },
      { worktreePath: "/selected/wt" },
      { startFromOrigin: true },
    ])("keeps a workspace picked before it arrives: %j", async (selection) => {
      const id = await open();
      store().setDraftThreadContext(id, selection);
      const selectedDraft = store().getDraftSession(id);
      await lateWorktreeDefault();
      expect(store().getDraftSession(id)).toEqual(selectedDraft);
    });
    it.each(["promotion", "shell", "mapping", "project", "thread", "disappearance"] as const)(
      "drops it after %s",
      async (change) => {
        const id = await open();
        const opened = store().getDraftSession(id)!;
        if (change === "promotion")
          markPromotedDraftThreadByRef(scopeThreadRef(projectRef.environmentId, opened.threadId));
        else if (change === "shell") testState.shellExists = true;
        else if (change === "mapping")
          store().setLogicalProjectDraftThreadId(
            "remote-project",
            projectRef,
            DraftId.make("winner"),
            { threadId: ThreadId.make("winner-thread"), envMode: "local" },
          );
        else {
          const sessions = { ...store().draftThreadsByThreadKey };
          if (change === "disappearance") delete sessions[id];
          else
            sessions[id] = {
              ...sessions[id]!,
              ...(change === "project"
                ? { projectId: ProjectId.make("other") }
                : { threadId: ThreadId.make("other") }),
            };
          useComposerDraftStore.setState({ draftThreadsByThreadKey: sessions });
        }
        const before = store().draftThreadsByThreadKey;
        await lateWorktreeDefault();
        expect(store().draftThreadsByThreadKey).toEqual(before);
      },
    );
    it.each(["text", "attachment"] as const)("still applies it after typed %s", async (kind) => {
      const id = await open();
      if (id === draftId) invest(kind);
      else store().setPrompt(id, "keep this work");
      await lateWorktreeDefault();
      expect(store().getDraftSession(id)?.envMode).toBe("worktree");
    });
  },
);
it("replaces a seeded New worktree base when the late default is local", async () => {
  seed(true);
  testState.settings.defaultThreadEnvMode = null;
  testState.cachedProjectFile = {
    known: true,
    file: { defaultThreadEnvMode: "worktree" } as GoatProjectFile,
  };
  await useNewThreadHandler()(projectRef);
  // BranchToolbarBranchSelector fills an empty base branch on its own once refs load.
  store().setDraftThreadContext(draftId, { branch: "main" });
  await testState.completeProjectFileRead({ defaultThreadEnvMode: "local" } as GoatProjectFile);
  expect(store().getDraftSession(draftId)).toMatchObject({
    envMode: "local",
    branch: null,
    worktreePath: null,
  });
});
it("keeps a base branch picked in worktree mode before the project file arrives", async () => {
  seed(true);
  testState.settings.defaultThreadEnvMode = null;
  testState.cachedProjectFile = {
    known: true,
    file: { defaultThreadEnvMode: "worktree" } as GoatProjectFile,
  };
  await useNewThreadHandler()(projectRef);
  // A pick in the branch selector, which an automatic seed would look identical to.
  noteDraftWorkspacePick(draftId);
  store().setDraftThreadContext(draftId, { branch: "feature", environmentSelection: "manual" });
  await testState.completeProjectFileRead({ defaultThreadEnvMode: "local" } as GoatProjectFile);
  expect(store().getDraftSession(draftId)).toMatchObject({
    envMode: "worktree",
    branch: "feature",
  });
});
it("keeps a mode chosen again before the project file arrives", async () => {
  seed(true);
  testState.settings.defaultThreadEnvMode = null;
  await useNewThreadHandler()(projectRef);
  // Choosing Local while the draft already shows Local leaves the stored value unchanged.
  noteDraftWorkspacePick(draftId);
  store().setDraftThreadContext(draftId, { envMode: "local", sshDestination: null });
  await testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" } as GoatProjectFile);
  expect(store().getDraftSession(draftId)?.envMode).toBe("local");
});

describe("new-thread SSH reset", () => {
  const destination = {
    connectionId: "saved-host",
    environmentId: EnvironmentId.make("destination"),
  };
  function chooseSsh() {
    store().setDraftThreadContext(draftId, {
      envMode: "worktree",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      sshDestination: destination,
    });
  }
  it.each(["local", "worktree"] as const)("resets a reused empty SSH draft to %s", async (mode) => {
    seed(true);
    chooseSsh();
    testState.settings.defaultThreadEnvMode = mode;
    await useNewThreadHandler()(projectRef);
    expect(store().getDraftSession(draftId)).toMatchObject({ envMode: mode, sshDestination: null });
  });
  it("keeps an invested SSH draft when minting a fresh draft", async () => {
    seed(true);
    chooseSsh();
    invest("text");
    const result = await useNewThreadHandler()(projectRef);
    expect(result?.draftId).not.toBe(draftId);
    expect(store().getDraftSession(draftId)?.sshDestination).toEqual(destination);
    expect(store().getDraftSession(result!.draftId)?.sshDestination).toBeNull();
  });
  it("keeps a host picked before the project file arrives", async () => {
    seed(true);
    testState.settings.defaultThreadEnvMode = null;
    await useNewThreadHandler()(projectRef);
    chooseSsh();
    await testState.completeProjectFileRead({
      defaultThreadEnvMode: "worktree",
    } as GoatProjectFile);
    expect(store().getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      sshDestination: destination,
    });
  });
});
