import { EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useSidebarProjectGroups } from "./useSidebarProjectGroups";

vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: ProjectId.make("archived"),
      environmentId: EnvironmentId.make("env"),
      title: "Archived project",
      workspaceRoot: "/archived",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-02-01T00:00:00.000Z",
    },
    {
      id: ProjectId.make("pinned"),
      environmentId: EnvironmentId.make("env"),
      title: "Pinned project",
      workspaceRoot: "/pinned",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinnedAt: "2026-02-01T00:00:00.000Z",
    },
  ],
  useQuietThreadShells: () => [],
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIdentities: () => [{ environmentId: EnvironmentId.make("env"), label: "Local" }],
  usePrimaryEnvironmentId: () => EnvironmentId.make("env"),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (selector: (state: { projectOrder: string[] }) => unknown) =>
    selector({ projectOrder: [] }),
  legacyProjectCwdPreferenceKey: (path: string) => path,
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) =>
    selector({
      sidebarProjectSortOrder: "manual",
      sidebarProjectGroupingMode: "separate",
      sidebarProjectGroupingOverrides: {},
    }),
}));

function Groups() {
  const groups = useSidebarProjectGroups();
  return <output>{groups.map((group) => group.displayName).join(", ")}</output>;
}

it("keeps archived project names and the configured order for every consumer", async () => {
  await using screen = await render(<Groups />, { router: false }); // No navigation in this fixture.
  await expect.element(screen.getByText("Archived project, Pinned project")).toBeInTheDocument();
});
