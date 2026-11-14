import { EnvironmentId, type HubNode } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { HubNodeStatus } from "./HubNodesSettings";

const now = Date.parse("2026-11-14T12:00:00.000Z");
const node = (machineClass?: HubNode["machineClass"]): HubNode => ({
  nodeId: EnvironmentId.make("env-1"),
  environmentId: EnvironmentId.make("env-1"),
  label: "cc-7",
  kind: "ssh",
  routes: [
    {
      routeId: "ssh:pen-cc7",
      source: "registration",
      target: { kind: "ssh", alias: "pen-cc7", hostname: null, username: null, port: null },
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
    },
  ],
  status: "online",
  lastSeenAt: null,
  addedBy: null,
  ...(machineClass === undefined ? {} : { machineClass }),
});

it("a Hub device shows its disposable class, Pen membership, who attached it and its state's age; a kept one shows none", async () => {
  // The row is a plain component; no route is involved.
  await using screen = await render(
    <HubNodeStatus
      now={now}
      node={node({
        class: "disposable",
        attachId: "a-1",
        state: "linked",
        stateSince: "2026-11-14T10:00:00.000Z",
        provisioner: { kind: "thread", threadId: "thread-1" },
        penMember: true,
        conflicts: [],
      })}
    />,
    { router: false },
  );
  await expect.element(screen.getByText("Disposable", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Still in Pen", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText(/Attached by thread thread-1 · linked for 2h/))
    .toBeVisible();
  screen.rerender(<HubNodeStatus now={now} node={node()} />);
  await expect.element(screen.getByText("Disposable", { exact: true })).not.toBeInTheDocument();
});
