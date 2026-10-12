import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentAuthorizationError,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  SshWorkspaceError,
  type ScopedThreadRef,
} from "@goat/contracts";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  primary: null as Atom.Writable<EnvironmentId | null> | null,
  catalog: null as Atom.Writable<{
    entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  }> | null,
  thread: null as Atom.Writable<{ projectId: ProjectId; branch: string | null } | null> | null,
  project: null as Atom.Writable<{ workspaceRoot: string } | null> | null,
  permitted: null as Atom.Writable<boolean> | null,
  execute: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/primaryEnvironment", () => ({
  get primaryEnvironmentIdAtom() {
    return state.primary;
  },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    get catalogValueAtom() {
      return state.catalog;
    },
  },
}));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => state.thread },
}));
vi.mock("~/state/projects", () => ({ environmentProjects: { projectAtom: () => state.project } }));
vi.mock("~/state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useThreadShell: () => useAtomValue(state.thread!),
    useProject: () => useAtomValue(state.project!),
  };
});
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    sshWorkspaceFetchBack: {
      permissionAtom: (environmentId: EnvironmentId | null) => {
        if (environmentId !== null && environmentId !== "local")
          throw new Error("Permission read on the remote environment");
        return state.permitted;
      },
    },
    refreshStatus: "refresh-status",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refresh-status" ? state.refresh : state.execute,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => state.toast(...args) },
}));

import { useSshWorkspaceFetchBack } from "./useSshWorkspaceFetchBack";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = { environmentId: remote, threadId: ThreadId.make("thread") };
const target = { alias: "build", hostname: "build.example", username: "dev", port: 2222 };
const localRef = "refs/remotes/goat-ssh/build/feature/result";
const fetched = {
  localRef,
  localWorkspaceRoot: "/local/app",
  sourceProjectId: ProjectId.make("local-project"),
  commitOid: "1234567890123456789012345678901234567890",
  remoteBranch: "feature/result",
};
const entries = (): ReadonlyMap<EnvironmentId, ConnectionCatalogEntry> =>
  new Map([
    [
      local,
      {
        enabled: true,
        profile: Option.none(),
        target: new PrimaryConnectionTarget({
          environmentId: local,
          label: "This device",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
      },
    ],
    [
      remote,
      {
        enabled: true,
        target: new SshConnectionTarget({
          environmentId: remote,
          connectionId: "saved",
          label: "Build",
        }),
        profile: Option.some(
          new SshConnectionProfile({
            environmentId: remote,
            connectionId: "saved",
            label: "Build",
            target,
          }),
        ),
      },
    ],
  ]);
let renderer: ReactTestRenderer | undefined;
let actions: Array<ReturnType<typeof useSshWorkspaceFetchBack>> = [];
function Probe({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  actions.push(useSshWorkspaceFetchBack(threadRef));
  return null;
}
async function mount(threadRef: ScopedThreadRef | null = ref, count = 1) {
  await act(() => {
    const content = (
      <RegistryContext.Provider value={state.registry!}>
        {Array.from({ length: count }, (_, index) => (
          <Probe key={index} threadRef={threadRef} />
        ))}
      </RegistryContext.Provider>
    );
    if (renderer) renderer.update(content);
    else renderer = create(content);
  });
  return actions.at(-1)!;
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: {} });
  state.registry = AtomRegistry.make();
  state.primary = Atom.make<EnvironmentId | null>(local);
  state.catalog = Atom.make({ entries: entries() });
  state.thread = Atom.make<{ projectId: ProjectId; branch: string | null } | null>({
    projectId: ProjectId.make("remote-project"),
    branch: "feature/result",
  });
  state.project = Atom.make<{ workspaceRoot: string } | null>({
    workspaceRoot: "/home/dev/.goat/repos/app-12345678",
  });
  state.permitted = Atom.make(true);
  state.execute.mockReset().mockResolvedValue(AsyncResult.success(fetched));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
  actions = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});
describe("useSshWorkspaceFetchBack", () => {
  it("fetches on this device and shows the exact returned ref without changing the remote thread", async () => {
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledWith({
      environmentId: local,
      input: {
        target,
        remoteWorkspaceRoot: "/home/dev/.goat/repos/app-12345678",
        branch: "feature/result",
      },
    });
    expect(state.registry!.get(state.thread!)).toEqual({
      projectId: "remote-project",
      branch: "feature/result",
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: localRef,
        data: expect.objectContaining({ threadRef: ref }),
      }),
    );
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: local,
      input: { cwd: "/local/app" },
    });
  });
  it("prevents simultaneous menu and palette requests until the first finishes", async () => {
    const result = deferred<ReturnType<typeof AsyncResult.success<typeof fetched>>>();
    state.execute.mockReturnValue(result.promise);
    await mount(ref, 2);
    const first = actions.at(-2)!;
    const second = actions.at(-1)!;
    let running!: Promise<void>;
    await act(async () => {
      running = first.run();
      await second.run();
    });
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(actions.at(-1)?.isPending).toBe(true);
    await act(async () => {
      result.resolve(AsyncResult.success(fetched));
      await running;
    });
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("keeps a fetch pending across unmounting all subscribers and returning", async () => {
    const tasks: Array<() => void> = [];
    state.registry!.dispose();
    state.registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    // The app owns these context atoms independently of the fetch UI.
    state.registry.mount(state.primary!);
    state.registry.mount(state.catalog!);
    state.registry.mount(state.thread!);
    state.registry.mount(state.project!);
    state.registry.mount(state.permitted!);
    const result = deferred<ReturnType<typeof AsyncResult.success<typeof fetched>>>();
    state.execute.mockReturnValue(result.promise);
    const action = await mount(ref, 2);
    let running!: Promise<void>;
    await act(() => {
      running = action.run();
    });
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(actions.at(-1)?.isPending).toBe(true);
    try {
      await act(() => {
        renderer!.unmount();
        renderer = undefined;
      });
      // Drain deferred registry cleanup so the remount cannot reuse an idle atom.
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
      const returned = await mount(ref, 2);
      await act(() => {
        void returned.run();
      });
      expect(state.execute).toHaveBeenCalledTimes(1);
      expect(actions.at(-1)?.isPending).toBe(true);
      expect(actions.at(-1)?.disabled).toBe(true);
      expect(actions.at(-1)?.label).toBe("Fetching branch to this device...");
    } finally {
      await act(async () => {
        result.resolve(AsyncResult.success(fetched));
        await running;
      });
    }
    expect(actions.at(-1)?.isPending).toBe(false);
    expect(actions.at(-1)?.disabled).toBe(false);
  });
  it("rechecks a revoked local grant and never dispatches from a retained callback", async () => {
    const action = await mount();
    await act(() => state.registry!.set(state.permitted!, false));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", timeout: 0 }),
    );
  });
  it("rechecks a removed saved connection and never fetches from a retained callback", async () => {
    const action = await mount();
    await act(() => state.registry!.set(state.catalog!, { entries: new Map() }));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("blocks a disabled host or a missing branch or project after the menu opened", async () => {
    const action = await mount();
    const disabled = new Map(entries());
    disabled.set(remote, { ...disabled.get(remote)!, enabled: false });
    await act(() => state.registry!.set(state.catalog!, { entries: disabled }));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Enable this SSH environment"),
      }),
    );
    await act(() => {
      state.registry!.set(state.catalog!, { entries: entries() });
      state.registry!.set(state.thread!, {
        projectId: ProjectId.make("remote-project"),
        branch: null,
      });
    });
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringContaining("no branch") }),
    );
    await act(() => state.registry!.set(state.project!, null));
    await act(() => action.run());
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("uses a renamed current branch when the old palette callback runs", async () => {
    const action = await mount();
    await act(() =>
      state.registry!.set(state.thread!, {
        projectId: ProjectId.make("remote-project"),
        branch: "feature/renamed",
      }),
    );
    await act(() => action.run());
    expect(state.execute.mock.calls[0]?.[0].input.branch).toBe("feature/renamed");
  });
  it("shows server refusal or transport failure once and allows only an explicit retry", async () => {
    const failures = [
      [
        new SshWorkspaceError({ stage: "validate", code: "source_not_found", host: "build" }),
        "Could not find the local source project for this remote workspace.",
      ],
      [
        new SshWorkspaceError({ stage: "validate", code: "source_ambiguous", host: "build" }),
        "More than one local source project matches this remote workspace. Resolve the duplicate projects.",
      ],
      [
        new SshWorkspaceError({ stage: "validate", code: "project_read_failed", host: "build" }),
        "Could not read the local project. Check access before trying again.",
      ],
      [
        new SshWorkspaceError({ stage: "validate", code: "invalid_branch", host: "build" }),
        "The remote branch is invalid. Choose a valid workspace branch.",
      ],
      [
        new SshWorkspaceError({ stage: "validate", code: "invalid_target", host: "build" }),
        "This saved SSH target is invalid. Choose another host or update Connections.",
      ],
      [
        new SshWorkspaceError({ stage: "fetch", code: "host_unavailable", host: "build" }),
        "Could not reach build. Check its SSH connection before trying again.",
      ],
      [
        new SshWorkspaceError({ stage: "fetch", code: "invalid_remote_response", host: "build" }),
        "build returned an invalid response. Check its server before trying again.",
      ],
      [
        new SshWorkspaceError({ stage: "fetch", code: "foreign_path", host: "build" }),
        "The remote path is not owned by this SSH workspace. Choose another destination.",
      ],
      [
        new SshWorkspaceError({ stage: "fetch", code: "fetch_failed", host: "build" }),
        "Could not fetch the remote changes. Check the SSH connection and repository.",
      ],
      [
        new EnvironmentAuthorizationError({
          message: "denied",
          requiredScope: AuthSourceControlWriteScope,
        }),
        "This device's connection cannot change source control.",
      ],
      [
        new Error("WebSocket disconnected"),
        "Could not fetch the remote branch. Check the connection before trying again.",
      ],
    ] as const;
    for (const [error, description] of failures) {
      state.execute.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(error)));
      const action = await mount();
      const before = state.execute.mock.calls.length;
      const toastsBefore = state.toast.mock.calls.length;
      await act(() => action.run());
      expect(state.execute).toHaveBeenCalledTimes(before + 1);
      expect(state.toast).toHaveBeenCalledTimes(toastsBefore + 1);
      expect(state.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "error", description, timeout: 0 }),
      );
      expect(description).not.toMatch(/draft was kept|may already have started/i);
      expect(actions.at(-1)?.isPending).toBe(false);
      expect(state.refresh).not.toHaveBeenCalled();
    }
    await act(() => actions.at(-1)!.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
  });
  it("clears pending after interruption without reporting success or retrying", async () => {
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.interrupt(0)));
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).not.toHaveBeenCalled();
    expect(actions.at(-1)?.isPending).toBe(false);
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it("keeps fetch success when local status refresh fails without fetching again", async () => {
    state.refresh.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Local refresh unavailable"))),
    );
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Branch fetched; local Git status refresh failed",
        description: "Local refresh unavailable",
      }),
    );
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("retains fetch success and suppresses an interrupted local refresh error", async () => {
    state.refresh.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    const action = await mount();
    await act(() => action.run());
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", description: localRef }),
    );
    expect(actions.at(-1)?.isPending).toBe(false);
  });
  it("uses bounded fallback copy for unstructured fetch or refresh failures", async () => {
    state.execute.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail("unstructured fetch error")),
    );
    const action = await mount();
    await act(() => action.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: "Could not fetch the remote branch. Check the connection before trying again.",
      }),
    );
    state.refresh.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail("unstructured refresh error")),
    );
    await act(() => action.run());
    expect(state.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Refresh Git status to see the fetched ref." }),
    );
  });
  it("keeps an in-flight result attributed to the original thread after navigation", async () => {
    const result = deferred<ReturnType<typeof AsyncResult.success<typeof fetched>>>();
    state.execute.mockReturnValue(result.promise);
    const action = await mount();
    let running!: Promise<void>;
    await act(() => {
      running = action.run();
    });
    await mount({ ...ref, threadId: ThreadId.make("other-thread") });
    await act(async () => {
      result.resolve(AsyncResult.success(fetched));
      await running;
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ threadRef: ref }) }),
    );
  });
});
