import type { FleetSubagent, FleetThread } from "@goat/client-runtime/state/fleet";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FleetThreadList } from "./FleetThreadList";

const local = EnvironmentId.make("local");

function subagent(id: string, status: FleetSubagent["status"] = "running"): FleetSubagent {
  return { key: id, ref: null, title: id, status };
}

function thread(subagents: ReadonlyArray<FleetSubagent>): FleetThread {
  return {
    key: "parent",
    machineId: "mac",
    ref: { environmentId: local, threadId: ThreadId.make("parent") },
    title: "Parent",
    agentKey: "codex",
    agentLabel: "Codex",
    agentDriver: null,
    state: "running",
    createdAt: "2026-10-22T00:00:00.000Z",
    reportedBy: null,
    subagents,
  };
}

describe("FleetThreadList native subagents", () => {
  it("collapses a thread's live native subagents into one chip on its row", async () => {
    await using screen = await render(
      <FleetThreadList threads={[thread([subagent("/root/reader")])]} />,
      { router: "/fleet" },
    );
    await expect
      .element(screen.getByRole("button", { name: /^1 subagent: \/root\/reader, Running$/ }))
      .toBeVisible();
    expect(screen.container.querySelectorAll("li")).toHaveLength(1);
    await expect
      .element(screen.getByRole("link", { name: "Parent" }))
      .toHaveAttribute("href", "/local/parent");

    await screen.rerender(
      <FleetThreadList
        threads={[thread([subagent("/root/reader"), subagent("Explore", "waiting")])]}
      />,
    );
    const chip = screen.getByRole("button", { name: /^2 subagents:/ });
    await expect.element(chip).toHaveTextContent("+2");
    await userEvent.hover(chip);
    await expect.element(page.getByText("2 subagents working in this thread")).toBeVisible();
    await expect.element(page.getByText("· Waiting")).toBeVisible();

    await screen.rerender(<FleetThreadList threads={[thread([])]} />);
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    expect(screen.container.querySelectorAll("li")).toHaveLength(1);
  });
});
