import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@goat/contracts";
import { scopeProjectRef } from "@goat/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  clones: [] as ProjectCloneSnapshot[],
  add: vi.fn(() => "toast"),
}));

// Plain factories keep the RPC runtime out; the silence state is the real module.
vi.mock("../state/projectClones", async () => ({
  ...(await import("../state/projectCloneToastSilence")),
  useEnvironmentProjectClones: () => state.clones,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "studio" }] }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => () => undefined }));
vi.mock("../hooks/useRemoveClonedProject", () => ({
  useRemoveClonedProject: () => () => undefined,
}));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { cancelProjectClone: {}, retryProjectClone: {} },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, update: () => undefined, close: () => undefined },
}));
vi.mock("./ui/toastHelpers", () => ({ stackedThreadToast: (options: unknown) => options }));

import {
  silenceProjectCloneToasts,
  unsilenceProjectCloneToasts,
} from "../state/projectCloneToastSilence";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";

const ref = scopeProjectRef(EnvironmentId.make("studio"), ProjectId.make("cloned"));

it("toasts a clone handed back from a draft at once, without waiting for its next snapshot", async () => {
  state.add.mockClear();
  state.clones = [
    {
      projectId: ref.projectId,
      remoteUrl: "https://github.com/octocat/Hello-World.git",
      destinationPath: "/tmp/runon-clones/Hello-World",
      repository: null,
      phase: "running",
      stage: "receiving",
      percent: 40,
      detail: null,
      error: null,
      startedAt: "2026-11-09T00:00:00.000Z",
      endedAt: null,
      sequence: 3,
    } as ProjectCloneSnapshot,
  ];
  silenceProjectCloneToasts(ref);
  await using _screen = await render(<ProjectCloneToastCoordinator />);
  expect(state.add).not.toHaveBeenCalled();

  await act(() => unsilenceProjectCloneToasts(ref));

  await vi.waitFor(() =>
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cloning Hello-World",
        description: "Receiving objects · 40%",
      }),
    ),
  );
});
