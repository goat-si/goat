import { EnvironmentId } from "@goat/contracts";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({ navigations: [] as unknown[] }));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { sourceControlProviders: [] }, error: null })) as never,
}));
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  useSourceControlPublishRepositoryAction: (() => ({
    isAllowed: true,
    isPending: false,
    run: async () => undefined,
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async (options: unknown) => {
    state.navigations.push(options);
  }) as never,
}));

import { PublishRepositoryDialog } from "./PublishRepositoryDialog";

it("points to Settings > Source control when every host is turned off for publishing", async () => {
  state.navigations = [];
  const everyHostOff = Object.fromEntries(
    sourceControlClients.definitions.map((definition) => [definition.kind, false]),
  );
  await using _screen = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      gitCwd="/repo"
      offerSettings={{ offeredSourceControlProviders: everyHostOff }}
    />,
  );
  await expect.element(page.getByText(/No host is offered for publishing/)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Open Settings > Source control" }));
  expect(state.navigations).toEqual([{ to: "/settings/source-control" }]);
});
