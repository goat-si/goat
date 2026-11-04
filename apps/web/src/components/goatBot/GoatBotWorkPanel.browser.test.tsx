import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

vi.mock("./useBotRoster", () => ({ useBotRoster: () => ({ rows: [] }) }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: { tasks: [] } }) }));
vi.mock("~/state/server", () => ({ serverEnvironment: { scheduledTasksLive: () => null } }));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";

it("shows the empty state for each work tab", async () => {
  await using screen = await render(
    <GoatBotWorkPanel environmentId={EnvironmentId.make("env")} threadId={ThreadId.make("bot")} />,
  );
  await expect.element(screen.getByText("No task threads yet.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Routines" }));
  await expect.element(screen.getByText("Ask GOAT Bot in chat to set up a routine.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await expect.element(screen.getByText("Files GOAT Bot saves will appear here.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Computer" }));
  await expect
    .element(screen.getByText("Machines GOAT Bot works on will appear here."))
    .toBeVisible();
});
