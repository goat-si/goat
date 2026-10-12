import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ServerSettings,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: T3ProjectFile | null) => void = () => undefined;
  let projectFileRead = Promise.resolve<T3ProjectFile | null>(null);
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
    get projectFileRead() {
      return projectFileRead;
    },
    completeProjectFileRead: (value: T3ProjectFile | null) => completeProjectFileRead(value),
    defer() {
      projectFileRead = new Promise((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
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
    ]),
}));
vi.mock("@t3tools/shared/projectSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/projectSettings")>()),
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
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
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
  readProjects: () => [
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
  testState.shellExists = false;
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
    it("abandons a delayed open after navigation", async () => {
      prepare();
      testState.settings.defaultThreadEnvMode = null;
      const before = store().getDraftSession(draftId);
      const pending = useNewThreadHandler()(projectRef);
      testState.router.state.location.href = "/usage";
      testState.completeProjectFileRead(null);
      expect(await pending).toBeNull();
      expect(store().getDraftSession(draftId)).toEqual(before);
      expect(testState.router.navigate).not.toHaveBeenCalled();
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
    const pending = useNewThreadHandler()(projectRef);
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" } as T3ProjectFile);
    await pending;
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
describe.each(["stored", "active", "fallback"] as const)("async reuse guards for %s", (path) => {
  it.each([
    { envMode: "local" as const },
    { branch: "selected-base" },
    { worktreePath: "/selected/wt" },
    { startFromOrigin: false },
  ])("preserves workspace picked during defaults read: %j", async (selection) => {
    seed(path !== "stored", path === "fallback");
    testState.settings.defaultThreadEnvMode = null;
    testState.settings.newWorktreesStartFromOrigin = true;
    const pending = useNewThreadHandler()(projectRef);
    store().setDraftThreadContext(draftId, selection);
    const selectedDraft = store().getDraftSession(draftId);
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" } as T3ProjectFile);
    const result = await pending;
    expect(store().getDraftSession(draftId)).toEqual(selectedDraft);
    expect(result).toBeNull();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });
  it("still resets when the branch selector seeds an empty New worktree base", async () => {
    seed(path !== "stored", path === "fallback");
    store().setDraftThreadContext(draftId, { branch: null, worktreePath: null });
    testState.settings.defaultThreadEnvMode = null;
    const pending = useNewThreadHandler()(projectRef);
    // BranchToolbarBranchSelector fills an empty base branch on its own once refs load.
    store().setDraftThreadContext(draftId, { branch: "main" });
    testState.completeProjectFileRead({} as T3ProjectFile);
    await pending;
    expect(store().getDraftSession(draftId)).toMatchObject({
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });
  it.each([
    "promotion",
    "shell",
    "mapping",
    "environment",
    "project",
    "thread",
    "disappearance",
    "text",
    "attachment",
  ] as const)("preserves changes during read: %s", async (change) => {
    seed(path !== "stored", path === "fallback");
    testState.settings.defaultThreadEnvMode = null;
    const pending = useNewThreadHandler()(projectRef);
    expect(store().getDraftSession(draftId)?.worktreePath).toBe("/old/wt");
    if (change === "promotion")
      markPromotedDraftThreadByRef(scopeThreadRef(projectRef.environmentId, threadId));
    else if (change === "shell") testState.shellExists = true;
    else if (change === "mapping")
      store().setLogicalProjectDraftThreadId("remote-project", projectRef, DraftId.make("winner"), {
        threadId: ThreadId.make("winner-thread"),
        worktreePath: "/winner",
        envMode: "worktree",
      });
    else if (change === "text" || change === "attachment") invest(change);
    else {
      const sessions = { ...store().draftThreadsByThreadKey };
      const key = draftId;
      if (change === "disappearance") delete sessions[key];
      else
        sessions[key] = {
          ...sessions[key]!,
          ...(change === "environment"
            ? { environmentId: EnvironmentId.make("other") }
            : change === "project"
              ? { projectId: ProjectId.make("other") }
              : { threadId: ThreadId.make("other") }),
        };
      useComposerDraftStore.setState({ draftThreadsByThreadKey: sessions });
    }
    const before = store().draftThreadsByThreadKey;
    testState.completeProjectFileRead(null);
    expect(await pending).toBeNull();
    expect(store().draftThreadsByThreadKey).toEqual(before);
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });
});
it("abandons an inactive draft opened by another request", async () => {
  seed();
  testState.settings.defaultThreadEnvMode = null;
  const pending = useNewThreadHandler()(projectRef);
  // Same href isolates the opened-meanwhile guard from the navigation guard.
  testState.router.state.matches = [{ params: { draftId } }];
  testState.completeProjectFileRead(null);
  expect(await pending).toBeNull();
  expect(store().getDraftSession(draftId)?.worktreePath).toBe("/old/wt");
});
it("allows reset of a draft already open when defaults read begins", async () => {
  seed(true);
  testState.settings.defaultThreadEnvMode = null;
  const pending = useNewThreadHandler()(projectRef);
  testState.completeProjectFileRead(null);
  await pending;
  expectReset();
  expect(testState.router.navigate).not.toHaveBeenCalled();
});
it("retains concurrent fresh-creation winner context", async () => {
  testState.settings.defaultThreadEnvMode = null;
  const pending = useNewThreadHandler()(projectRef);
  seed();
  const before = store().getDraftSession(draftId);
  testState.completeProjectFileRead(null);
  expect(await pending).toEqual({ draftId, threadId });
  expect(store().getDraftSession(draftId)).toEqual(before);
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
  it("does not clear the concurrently registered winner's SSH destination", async () => {
    testState.settings.defaultThreadEnvMode = null;
    const pending = useNewThreadHandler()(projectRef);
    seed();
    chooseSsh();
    testState.completeProjectFileRead(null);
    await pending;
    expect(store().getDraftSession(draftId)?.sshDestination).toEqual(destination);
  });
  it("keeps a host pick during a pending defaults read", async () => {
    seed(true);
    testState.settings.defaultThreadEnvMode = null;
    const pending = useNewThreadHandler()(projectRef);
    chooseSsh();
    testState.completeProjectFileRead(null);
    expect(await pending).toBeNull();
    expect(store().getDraftSession(draftId)?.sshDestination).toEqual(destination);
  });
});
