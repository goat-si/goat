import { expect, it, vi } from "vite-plus/test";
import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@goat/contracts";
import * as palette from "../commandPaletteBus";
import * as grouping from "../sidebarProjectGrouping";
import * as entities from "../state/entities";
import * as context from "./useHandleNewThread";
import { createStartChatNew } from "./useStartChatNew";

it("offers the picker for multiple projects even when last work exists", async () => {
  using _groups = vi
    .spyOn(grouping, "buildSidebarProjectSnapshots")
    .mockReturnValue([{ archived: false }, { archived: false }] as ReturnType<
      typeof grouping.buildSidebarProjectSnapshots
    >);
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("one");
  using _projects = vi
    .spyOn(entities, "readProjects")
    .mockReturnValue([{ environmentId, id: projectId, archivedAt: null }] as unknown as ReturnType<
      typeof entities.readProjects
    >);
  using _threads = vi.spyOn(entities, "readThreadShells").mockReturnValue([
    {
      environmentId,
      projectId,
      archivedAt: null,
      latestUserAuthoredMessageAt: "2026-10-10T10:00:00Z",
      latestUserMessageAt: "2026-10-10T10:00:00Z",
      worktreePath: null,
    },
  ] as unknown as ReturnType<typeof entities.readThreadShells>);
  const handleNewThread = vi.fn();
  using _context = vi.spyOn(context, "readNewThreadContext").mockReturnValue({
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: null,
    handleNewThread,
  } as ReturnType<typeof context.readNewThreadContext>);
  using picker = vi.spyOn(palette, "openCommandPalette").mockImplementation(() => {});
  await createStartChatNew({} as AnyRouter)();
  expect(picker).toHaveBeenCalledWith({ open: "new-thread-in" });
  expect(handleNewThread).not.toHaveBeenCalled();
});
