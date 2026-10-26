import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const authorizationMocks = vi.hoisted(() => ({
  sessionAtom: null as Atom.Atom<
    AsyncResult.AsyncResult<Pick<AuthSessionState, "authenticated" | "scopes">, Error>
  > | null,
  phase: "connected" as "connected" | "offline",
}));

vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => authorizationMocks.sessionAtom },
}));

vi.mock("~/state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: authorizationMocks.phase, error: null } },
  }),
}));

const projectMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  optimisticFile: vi.fn(),
  readFile: vi.fn(),
}));

const atomHooks = vi.hoisted(() => ({
  registry: null as {
    get(atom: object): unknown;
    refresh(atom: object): void;
  } | null,
}));

const reactHooks = vi.hoisted(() => {
  let cursor = 0;
  let refs: Array<{ current: unknown }> = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      refs = [];
    },
    useCallback<A>(callback: A): A {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void): void {
      nextIndex();
      effect();
    },
    useRef<A>(initialValue: A): { current: A } {
      const index = nextIndex();
      refs[index] ??= { current: initialValue };
      return refs[index] as { current: A };
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (atom: object) => () => {
    atomHooks.registry?.refresh(atom);
  },
  useAtomValue: (atom: object) => atomHooks.registry?.get(atom),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: reactHooks.useCallback,
    useEffect: reactHooks.useEffect,
    useMemo: <A,>(factory: () => A) => factory(),
    useRef: reactHooks.useRef,
  };
});

vi.mock("~/state/projects", () => ({
  projectEnvironment: projectMocks,
}));

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: vi.fn(),
}));

import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useGoatProjectFileState } from "~/hooks/useGoatProjectFileScripts";
import { useProjectEntriesQuery, useProjectFileQuery } from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-1");

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function file(contents: string): ProjectReadFileResult {
  return {
    relativePath: "src/preview.ts",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

function projectEntries(paths: readonly string[]): ProjectListEntriesResult {
  return {
    entries: paths.map((path) => ({ path, kind: "file" })),
    truncated: false,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("project query refresh", () => {
  beforeEach(() => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
    );
    authorizationMocks.phase = "connected";
    projectMocks.listEntries.mockReset();
    projectMocks.optimisticFile.mockReset();
    projectMocks.readFile.mockReset();
    reactHooks.reset();
  });

  it("does not query or expose optimistic file contents without read permission", () => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [] }),
    );
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
    try {
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(query.data).toBeNull();
      expect(query.error).toBe("This connection cannot read host files.");
      expect(query.isPending).toBe(false);
      const entries = useProjectEntriesQuery(environmentId, "/repo");
      expect(projectMocks.listEntries).not.toHaveBeenCalled();
      expect(entries.data).toBeNull();
      expect(entries.error).toBe("This connection cannot read host files.");
      expect(entries.isPending).toBe(false);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reads the legacy file and overlays its in-app edits when goat.json is missing", () => {
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const primary = Atom.make(
      AsyncResult.failure(
        Cause.fail(
          new ProjectReadFileError({
            cwd: "/repo",
            relativePath: "goat.json",
            failure: "operation_failed",
            operation: "realpath-target",
            cause: new Error("ENOENT: no such file"),
          }),
        ),
      ),
    );
    const legacy = Atom.make(AsyncResult.success(file('{ "iconPath": "old.svg" }')));
    const optimistic = Atom.make({ data: file('{ "iconPath": "edited.svg" }') });
    const emptyOptimistic = Atom.make(null);
    projectMocks.readFile.mockImplementation(({ input }) =>
      input.relativePath === "goat.json" ? primary : legacy,
    );
    projectMocks.optimisticFile.mockImplementation(({ relativePath }) =>
      relativePath === LEGACY_PROJECT_FILE_NAME ? optimistic : emptyOptimistic,
    );
    try {
      expect(useGoatProjectFileState(environmentId, "/repo")).toMatchObject({
        status: "valid",
        file: { iconPath: "edited.svg" },
        relativePath: LEGACY_PROJECT_FILE_NAME,
      });
      expect(
        projectMocks.readFile.mock.calls.map(([request]) => request.input.relativePath),
      ).toEqual(["goat.json", LEGACY_PROJECT_FILE_NAME]);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("uses goat.json as the creation path when neither project file exists", () => {
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.readFile.mockImplementation(({ input }) =>
      Atom.make(
        AsyncResult.failure(
          Cause.fail(
            new ProjectReadFileError({
              cwd: "/repo",
              relativePath: input.relativePath,
              failure: "operation_failed",
              operation: "realpath-target",
              cause: new Error("ENOENT: no such file"),
            }),
          ),
        ),
      ),
    );
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useGoatProjectFileState(environmentId, "/repo")).toMatchObject({
        status: "missing",
        relativePath: "goat.json",
        file: null,
      });
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports invalid goat.json and avoids a legacy query", () => {
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.readFile.mockReturnValue(Atom.make(AsyncResult.success(file("{ invalid"))));
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useGoatProjectFileState(environmentId, "/repo")).toMatchObject({
        status: "invalid",
        relativePath: "goat.json",
        file: null,
      });
      expect(
        projectMocks.readFile.mock.calls.map(([request]) => request.input.relativePath),
      ).toEqual(["goat.json"]);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("keeps t3.json and the file tree loading until the file grant arrives", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const config = {
      defaultThreadEnvMode: "worktree",
      scripts: [{ name: "Test", command: "vp test" }],
    };
    projectMocks.readFile.mockReturnValue(
      Atom.make(AsyncResult.success(file(JSON.stringify(config)))),
    );
    projectMocks.listEntries.mockReturnValue(
      Atom.make(AsyncResult.success(projectEntries(["t3.json"]))),
    );
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    try {
      expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: null,
        error: null,
        isPending: true,
      });
      expect(useGoatProjectFileState(environmentId, "/repo").status).toBe("loading");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(projectMocks.listEntries).not.toHaveBeenCalled();

      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
      );
      expect(useGoatProjectFileState(environmentId, "/repo")).toEqual({
        status: "valid",
        file: config,
        scripts: config.scripts,
        relativePath: "goat.json",
      });
      expect(useProjectEntriesQuery(environmentId, "/repo")).toMatchObject({
        data: projectEntries(["t3.json"]),
        error: null,
        isPending: false,
      });
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it.each(["connected", "offline"] as const)(
    "preserves cached t3.json defaults and scripts during a granted refresh while %s",
    (phase) => {
      authorizationMocks.phase = phase;
      authorizationMocks.sessionAtom = Atom.make(
        AsyncResult.success(
          { authenticated: true, scopes: [AuthFilesystemReadScope] },
          { waiting: true },
        ),
      );
      const registry = AtomRegistry.make();
      atomHooks.registry = registry;
      const config = {
        defaultThreadEnvMode: "worktree",
        scripts: [{ name: "Test", command: "vp test" }],
      };
      projectMocks.readFile.mockReturnValue(
        Atom.make(AsyncResult.success(file(JSON.stringify(config)), { waiting: true })),
      );
      projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
      try {
        expect(useProjectFileQuery(environmentId, "/repo", "t3.json")).toMatchObject({
          error: null,
          isPending: true,
        });
        expect(useGoatProjectFileState(environmentId, "/repo")).toEqual({
          status: "valid",
          file: config,
          scripts: config.scripts,
          relativePath: "goat.json",
        });
      } finally {
        registry.dispose();
        atomHooks.registry = null;
      }
    },
  );

  it("refetches a listing when the workspace mutation changes, not when it is first read", () => {
    let fetches = 0;
    const listing = Atom.make(() => {
      fetches += 1;
      return AsyncResult.success({ entries: [], truncated: false });
    }).pipe(Atom.keepAlive);
    projectMocks.listEntries.mockReturnValue(listing);
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    const read = (mutationId: string | null) =>
      useProjectEntriesQuery(environmentId, "/repo", "src", mutationId);

    try {
      read("mutation-1");
      read("mutation-1");
      expect(fetches).toBe(1);

      read("mutation-2");
      expect(fetches).toBe(2);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("replaces an in-flight initial read when a workspace mutation arrives", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    const readAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;
    let renderedContents: string | null = null;

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(query.readError).toBeNull();
      renderedContents = query.data?.contents ?? null;
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:src/preview.ts",
      });
    };

    try {
      render(null);
      await flushEffects();
      expect(requests).toHaveLength(1);

      render("mutation-1");
      await flushEffects();
      expect(requests).toHaveLength(2);

      requests[1]!.resolve(file("fresh"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");

      requests[0]!.resolve(file("stale"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });
});

it("confirms files from reads and preserves that identity until a definitive folder result", () => {
  const contents = file("# readme");
  const success = AsyncResult.success(contents);
  const failure = (kind: ProjectReadFileError["failure"], cached = false) =>
    AsyncResult.failure(
      Cause.fail(
        new ProjectReadFileError({ cwd: "/repo", relativePath: "src/preview.ts", failure: kind }),
      ),
      { previousSuccess: cached ? Option.some(success) : Option.none() },
    );
  const states = [
    ["initial read", AsyncResult.initial(true), false, false, null],
    ["unknown path", failure("operation_failed"), false, false, null],
    ["binary file", failure("binary_file"), true, false, null],
    ["read success", success, true, false, contents],
    ["pending refresh", AsyncResult.waiting(success), true, false, contents],
    ["transient refresh failure", failure("operation_failed", true), true, false, contents],
    ["became a folder", failure("path_not_file", true), false, true, contents],
  ] as const;
  const readAtom = Atom.make<AsyncResult.AsyncResult<ProjectReadFileResult, ProjectReadFileError>>(
    AsyncResult.initial(true),
  );
  const registry = AtomRegistry.make();
  const unmount = registry.mount(readAtom);
  projectMocks.readFile.mockReturnValue(readAtom);
  projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
  atomHooks.registry = registry;

  try {
    for (const [label, result, isFile, isNotFile, data] of states) {
      registry.set(readAtom, result);
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(query.isFile, label).toBe(isFile);
      expect(query.isNotFile, label).toBe(isNotFile);
      expect(query.data, label).toBe(data);
      expect(query.isPending, label).toBe(result.waiting);
    }
  } finally {
    unmount();
    registry.dispose();
    atomHooks.registry = null;
  }
});
