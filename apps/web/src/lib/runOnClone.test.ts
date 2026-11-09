import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  addProjectToMachine: vi.fn(() => Promise.resolve()),
  arrive: new Map<string, (project: unknown) => void>(),
}));

vi.mock("./addProjectToMachine", () => ({ addProjectToMachine: state.addProjectToMachine }));
vi.mock("../state/entities", () => ({
  waitForProject: (ref: ScopedProjectRef) =>
    new Promise((resolve) => state.arrive.set(ref.projectId, resolve)),
}));

import { cloneForRunOn } from "./runOnClone";

const studio = EnvironmentId.make("studio");
const request = (projectId: string, remoteUrl: string) => ({
  source: { environmentId: EnvironmentId.make("laptop"), cwd: "/repo" },
  subdirectory: "",
  target: { environmentId: studio, label: "Mac Studio" },
  projectId: ProjectId.make(projectId),
  title: "direction-board",
  remoteUrl,
  destinationPath: "~/Developer/direction-board",
  files: [],
});

describe("cloneForRunOn", () => {
  it("shares a pending clone only with picks of the same repository, machine and folder", async () => {
    const upstream = "git@github.com:goat-si/direction-board.git";
    const first = await cloneForRunOn(request("first", upstream));
    const again = await cloneForRunOn(request("second", upstream));
    // A fork whose default folder collides is not this clone; the server refuses the busy folder.
    await cloneForRunOn(request("fork", "git@github.com:someone/direction-board.git"));

    expect(again.ref).toEqual(first.ref);
    expect(state.addProjectToMachine.mock.calls.map(([input]) => input.projectId)).toEqual([
      "first",
      "fork",
    ]);

    // Once the project arrives, a later pick starts afresh.
    state.arrive.get("first")?.({ id: "first" });
    await first.arrived;
    await vi.waitFor(async () => {
      await cloneForRunOn(request("third", upstream));
      expect(state.addProjectToMachine).toHaveBeenCalledTimes(3);
    });
  });
});
