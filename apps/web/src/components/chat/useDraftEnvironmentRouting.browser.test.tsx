import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@goat/contracts";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => {
  const projects = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const keyOf = (ref: ScopedProjectRef) => `${ref.environmentId}:${ref.projectId}`;
  return {
    projects,
    listeners,
    keyOf,
    addProjectToMachine: vi.fn(),
    toast: vi.fn(),
    unsilenceProjectCloneToasts: vi.fn(),
    projectArrivalTimesOut: false,
    setProject(ref: ScopedProjectRef, project: unknown) {
      projects.set(keyOf(ref), project);
      for (const listener of listeners.get(keyOf(ref)) ?? []) listener();
    },
  };
});

// Plain factories: the real modules reach the RPC runtime, which this hook test does not need.
vi.mock("../../lib/addProjectToMachine", () => ({
  addProjectToMachine: state.addProjectToMachine,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [...state.projects.values()],
  waitForProject: (ref: ScopedProjectRef) =>
    new Promise((resolve, reject) => {
      if (state.projectArrivalTimesOut) return reject(new Error("The project did not appear."));
      const key = state.keyOf(ref);
      const existing = state.projects.get(key);
      if (existing) return resolve(existing);
      const set = state.listeners.get(key) ?? new Set<() => void>();
      state.listeners.set(key, set);
      const notify = () => {
        const project = state.projects.get(key);
        if (!project) return;
        set.delete(notify);
        resolve(project);
      };
      set.add(notify);
    }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: () => Promise.resolve(null) }),
}));
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    failed: false,
    environmentId: null,
    refresh: () => undefined,
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../../state/projectClones", () => ({
  unsilenceProjectCloneToasts: state.unsilenceProjectCloneToasts,
}));
vi.mock("./chatViewSend", async () => {
  const { Atom } = await import("effect/reactivity");
  return { draftFanoutSelectionsAtom: Atom.family(() => Atom.make([])) };
});

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { MachineWithoutProject } from "../../lib/runOnArrival";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

const laptop = EnvironmentId.make("laptop");
const studio = EnvironmentId.make("studio");
const macmini = EnvironmentId.make("macmini");
const draftId = DraftId.make("draft");
const source = scopeProjectRef(laptop, ProjectId.make("source"));
const onMacmini = scopeProjectRef(macmini, ProjectId.make("on-macmini"));
const SOURCE = {
  environmentId: laptop,
  id: source.projectId,
  title: "direction-board",
  workspaceRoot: "/Users/jun/direction-board",
  repositoryIdentity: null,
};
const STUDIO: MachineWithoutProject = {
  environmentId: studio,
  projectId: null,
  label: "Mac Studio",
  isPrimary: false,
  machine: "desktop",
  arrival: {
    kind: "clone",
    remoteUrl: "git@github.com:goat-si/direction-board.git",
    destinationPath: "~/code/direction-board",
  },
};

type Routing = ReturnType<typeof useDraftEnvironmentRouting>;

/** The project the clone was started for; the client mints its id. */
const clonedRef = (): ScopedProjectRef =>
  scopeProjectRef(studio, state.addProjectToMachine.mock.calls[0]?.[0].projectId);

async function setup() {
  state.projects.clear();
  state.listeners.clear();
  state.addProjectToMachine.mockReset().mockResolvedValue(undefined);
  state.toast.mockReset();
  state.unsilenceProjectCloneToasts.mockReset();
  state.projectArrivalTimesOut = false;
  state.setProject(source, SOURCE);
  state.setProject(onMacmini, { ...SOURCE, environmentId: macmini, id: onMacmini.projectId });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId("direction-board", source, draftId, { envMode: "worktree" });
  const routing: { current: Routing | null } = { current: null };
  const capture = (value: Routing) => {
    routing.current = value;
  };
  function Harness(props: { capture: (value: Routing) => void }) {
    const value = useDraftEnvironmentRouting({
      draftId,
      // Read only for automatic routing, which these tests leave off.
      draftThread: null,
      envLocked: false,
      automaticEnvironment: false,
      logicalProjectEnvironments: [
        {
          environmentId: laptop,
          projectId: source.projectId,
          label: "Laptop",
          isPrimary: true,
          machine: "laptop",
        },
        {
          environmentId: macmini,
          projectId: onMacmini.projectId,
          label: "macmini",
          isPrimary: false,
          machine: "desktop",
        },
      ],
      machinesWithoutProject: [STUDIO],
      activeProject: SOURCE as never,
      environmentById: new Map(),
      providersByEnvironment: new Map() as never,
      loadBalancingSettings: { loadBalancingWeights: {} },
      referencedThreadContexts: [],
      activeProviderInstanceId: null,
      selectedProvider: "codex" as never,
      composerHasAttachments: false,
      activeProjectKey: "laptop:source",
      activeProjectIsScratch: false,
      projectGroupingSettings: {} as never,
      sendInFlightRef: { current: false },
    });
    props.capture(value);
    return null;
  }
  // router: false — the hook reads no route; the harness renders nothing.
  const screen = await render(<Harness capture={capture} />, { router: false });
  const draft = () => useComposerDraftStore.getState().getDraftSession(draftId);
  return Object.assign(screen, { routing, draft });
}

describe("useDraftEnvironmentRouting: machines without the project", () => {
  it("clones to the picked machine and moves the draft there once its project arrives, keeping New worktree", async () => {
    await using screen = await setup();

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));

    await vi.waitFor(() => expect(state.addProjectToMachine).toHaveBeenCalledTimes(1));
    const cloned = clonedRef();
    expect(state.addProjectToMachine.mock.calls[0]?.[0]).toMatchObject({
      target: { environmentId: studio, label: "Mac Studio" },
      remoteUrl: "git@github.com:goat-si/direction-board.git",
      destinationPath: "~/code/direction-board",
      files: [],
    });
    // The clone started, but this client has not seen the project yet.
    expect(screen.draft()?.environmentId).toBe(laptop);
    expect(screen.routing.current?.isEnvironmentChanging).toBe(true);

    await act(() =>
      state.setProject(cloned, { ...SOURCE, environmentId: studio, id: cloned.projectId }),
    );

    await vi.waitFor(() =>
      expect(screen.draft()).toMatchObject({
        environmentId: studio,
        projectId: cloned.projectId,
        envMode: "worktree",
        environmentSelection: "manual",
      }),
    );
    await vi.waitFor(() => expect(screen.routing.current?.isEnvironmentChanging).toBe(false));
  });

  it("keeps the draft where it was and says why when the clone cannot start", async () => {
    await using screen = await setup();
    state.addProjectToMachine.mockRejectedValue(new Error("Destination already exists."));

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));

    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.routing.current?.isEnvironmentChanging).toBe(false));
    expect(screen.draft()?.environmentId).toBe(laptop);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not clone direction-board to Mac Studio",
        description: "Destination already exists.",
      }),
    );
  });

  it("a newer machine pick wins over a pending clone, which then shows its own progress toast", async () => {
    await using screen = await setup();

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));
    await vi.waitFor(() => expect(state.addProjectToMachine).toHaveBeenCalledTimes(1));
    await act(() => screen.routing.current?.onEnvironmentChangeStable(macmini));
    const cloned = clonedRef();
    await act(() =>
      state.setProject(cloned, { ...SOURCE, environmentId: studio, id: cloned.projectId }),
    );

    await vi.waitFor(() => expect(state.unsilenceProjectCloneToasts).toHaveBeenCalledWith(cloned));
    expect(screen.routing.current?.isEnvironmentChanging).toBe(false);
    expect(screen.draft()).toMatchObject({
      environmentId: macmini,
      projectId: onMacmini.projectId,
    });
  });

  it("going back to a machine whose clone is still pending reuses that clone", async () => {
    await using screen = await setup();

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));
    await vi.waitFor(() => expect(state.addProjectToMachine).toHaveBeenCalledTimes(1));
    await act(() => screen.routing.current?.onEnvironmentChangeStable(macmini));
    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));
    const cloned = clonedRef();
    await act(() =>
      state.setProject(cloned, { ...SOURCE, environmentId: studio, id: cloned.projectId }),
    );

    await vi.waitFor(() =>
      expect(screen.draft()).toMatchObject({ environmentId: studio, projectId: cloned.projectId }),
    );
    expect(state.addProjectToMachine).toHaveBeenCalledTimes(1);
  });

  it("choosing an SSH host cancels a clone still waiting for its project", async () => {
    await using screen = await setup();

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));
    await vi.waitFor(() => expect(state.addProjectToMachine).toHaveBeenCalledTimes(1));
    // ChatView's SSH selection cancels the pending switch before it sets the destination.
    await act(() => screen.routing.current?.cancelEnvironmentChange());
    const cloned = clonedRef();
    await act(() =>
      state.setProject(cloned, { ...SOURCE, environmentId: studio, id: cloned.projectId }),
    );

    // Handing the clone back to its toast is the last thing a pick that cannot move the draft does.
    await vi.waitFor(() => expect(state.unsilenceProjectCloneToasts).toHaveBeenCalledWith(cloned));
    expect(screen.draft()).toMatchObject({ environmentId: laptop, projectId: source.projectId });
  });

  it("picking the machine again while it clones starts no second clone into the same folder", async () => {
    await using screen = await setup();

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));
    await vi.waitFor(() => expect(state.addProjectToMachine).toHaveBeenCalledTimes(1));
    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));

    expect(state.addProjectToMachine).toHaveBeenCalledTimes(1);
    const cloned = clonedRef();
    await act(() =>
      state.setProject(cloned, { ...SOURCE, environmentId: studio, id: cloned.projectId }),
    );
    await vi.waitFor(() => expect(screen.draft()?.environmentId).toBe(studio));
  });

  it("a started clone whose project is slow to arrive goes back to its own progress toast", async () => {
    await using screen = await setup();
    state.projectArrivalTimesOut = true;

    await act(() => screen.routing.current?.onEnvironmentChangeStable(studio));

    await vi.waitFor(() => expect(state.unsilenceProjectCloneToasts).toHaveBeenCalledTimes(1));
    expect(state.unsilenceProjectCloneToasts).toHaveBeenCalledWith(clonedRef());
    await vi.waitFor(() => expect(screen.routing.current?.isEnvironmentChanging).toBe(false));
    // The clone is still running, so nothing claims it failed; the draft stays put.
    expect(state.toast).not.toHaveBeenCalled();
    expect(screen.draft()?.environmentId).toBe(laptop);
  });
});
