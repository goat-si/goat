import { BotRemoteWork, BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ connected: new Set<string>() }));
vi.mock("~/state/environments", () => ({ useEnvironment: () => null }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined, error: null }) }));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listChildWork: () => null,
    // Whether this browser holds a live session to exactly that environment.
    remoteWorkOpenable: (environmentId: string) => Atom.make(state.connected.has(environmentId)),
  },
}));

import { GoatBotWorkDetails } from "./GoatBotWorkDetails";

const at = "2026-11-09T00:00:00.000Z";
const rows = [
  Schema.decodeSync(BotThreadRow)({
    kind: "task",
    task: { taskId: "task-1", title: "Restart the 3774 server", status: "running", updatedAt: at },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
  }),
];
const remoteWork = [
  Schema.decodeSync(BotRemoteWork)({
    childWorkId: "cw-restart",
    taskId: "task-1",
    callerThreadId: "channel-worker:task-1",
    host: "macbookpro2",
    state: "bound",
    lastActivityAt: at,
    threadId: "restart-3774",
    environmentId: "env-macbook",
    workKind: "chore",
  }),
];

const details = () => (
  <GoatBotWorkDetails
    environmentId={EnvironmentId.make("env-studio")}
    taskId={ChannelTaskId.make("task-1")}
    rows={rows}
    remoteWork={remoteWork}
  />
);

it("opens a chore on another machine in that machine, and says when it is unavailable", async () => {
  state.connected = new Set(["env-macbook"]);
  {
    await using screen = await render(details());
    // The destination's own thread, never the bot machine's thread with the same id.
    await expect
      .element(screen.getByRole("link", { name: "Open work thread on macbookpro2" }))
      .toHaveAttribute("href", "/env-macbook/restart-3774");
  }
  state.connected = new Set();
  await using screen = await render(details());
  await expect.element(screen.getByText("macbookpro2 · Unavailable")).toBeVisible();
  await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
});
