import { EnvironmentId, ProjectId, ProviderInstanceId } from "@goat/contracts";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarProjectScope } from "./SidebarProjectScope";

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: ({ project }: { project: { title: string } }) => (
    <span data-testid={`icon-${project.title}`} />
  ),
}));

const environmentId = EnvironmentId.make("test-environment");
const projects: Project[] = ["Alpha", "Alpine"].map((title) => ({
  id: ProjectId.make(title),
  environmentId,
  title,
  workspaceRoot: `/test/${title}`,
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
}));
const groups = buildSidebarProjectSnapshots({
  projects,
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: environmentId,
  resolveEnvironmentLabel: () => "Local",
});

function ScopeFixture() {
  const [keys, setKeys] = useState<readonly string[]>([]);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <TooltipProvider>
      <SidebarProvider>
        <div ref={anchor}>
          <SidebarProjectScope
            projectGroups={groups}
            scopedProjectGroups={groups.filter((group) => keys.includes(group.projectKey))}
            projectScopeKeys={keys}
            setProjectScopeKeys={setKeys}
            openProjectSettings={() => {}}
            showProjectEnvironments={false}
            primaryEnvironmentId={environmentId}
            environmentMachineById={new Map()}
            headerSearchRef={anchor}
          />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

describe("sidebar project scope", () => {
  it("keeps the query and menu open while shift-clicking projects and shows both icons", async () => {
    await using screen = await render(<ScopeFixture />, {
      // The picker does not navigate in this test.
      router: false,
    });
    await userEvent.click(screen.getByRole("combobox", { name: "Filter threads by project" }));
    const search = page.getByRole("combobox", { name: "Search projects" });
    await userEvent.fill(search, "Al");
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(page.getByRole("option", { name: "Alpha" }));
    await expect.element(search).toHaveValue("Al");
    await userEvent.click(page.getByRole("option", { name: "Alpine" }));
    await userEvent.keyboard("{/Shift}");
    await expect.element(search).toHaveValue("Al");
    const trigger = screen.getByRole("combobox", {
      name: "Filter threads by project: Alpha, Alpine",
    });
    await expect.element(trigger.getByTestId("icon-Alpha")).toBeInTheDocument();
    await expect.element(trigger.getByTestId("icon-Alpine")).toBeInTheDocument();
  });
});
