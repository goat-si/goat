import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";
import { CommandOutputPanel } from "./CommandOutputPanel";

const environmentQuery = vi.hoisted(() => ({ data: null as unknown }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    error: null,
    dataUpdatedAt: 0,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  })) as never,
}));

describe("CommandOutputPanel", () => {
  it("scrolls the truncation notice away with the output it precedes", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    environmentQuery.data = {
      output: { text: lines.join("\n"), truncated: true },
      running: false,
    };
    await using screen = await render(
      <CommandOutputPanel
        environmentId={EnvironmentId.make("environment-local")}
        threadId={ThreadId.make("thread-output")}
        itemId={TurnItemId.make("item-output")}
      />,
    );

    const output = screen.container.querySelector<HTMLElement>(".overflow-auto")!;
    // The panel follows the output to its end, so the notice above the first line is out of view.
    await vi.waitFor(() => expect(output.scrollTop).toBeGreaterThan(0));
    await expect.element(screen.getByText("Earlier output not shown")).not.toBeInViewport();
  });
});
