import { EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

vi.mock("@goat/client-runtime/thread-pull-request-compatibility", () => ({
  threadPullRequestLinkMode: () => "multiple",
}));
vi.mock("~/hooks/usePullRequestLinking", () => ({
  usePullRequestLinking: () => ({ mode: "multiple", canLink: () => true, isLinked: () => false }),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { linkedThreads: () => ({}) } }));
vi.mock("~/state/queries", () => ({ useThreadSearch: () => ({ failed: true, isPending: false }) }));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map(),
  useThreadShell: () => null,
  useProjects: () => [],
  useThreadShells: () => [
    {
      environmentId: "env",
      id: "thread",
      projectId: "project",
      archivedAt: null,
      title: "Retained thread",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
}));
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";

it("shows a search failure alongside retained thread choices", async () => {
  await using screen = await render(
    <PullRequestThreadLinks
      environmentId={EnvironmentId.make("env")}
      reference={{ projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 }}
      url="https://github.com/owner/repo/pull/1"
      threadRef={null}
      display="picker"
    />,
  );
  await expect.element(screen.getByText("Retained thread")).toBeInTheDocument();
  await expect.element(screen.getByText("Couldn't search threads.")).toBeInTheDocument();
});
