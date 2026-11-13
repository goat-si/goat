import {
  BotRemoteWork,
  BotThreadRow,
  BotWorkResult,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ connected: new Set<string>(), supported: false, reads: 0 }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () =>
    state.supported
      ? {
          connection: { phase: "connected" },
          serverConfig: { environment: { capabilities: { goatBotChildWork: true } } },
        }
      : null,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listChildWork: () => childWork,
    // Whether this browser holds a live session to exactly that environment.
    remoteWorkOpenable: (environmentId: string) => Atom.make(state.connected.has(environmentId)),
  },
}));

import { GoatBotUnavailableWork, GoatBotWorkDetails } from "./GoatBotWorkDetails";

const childWork = Atom.make(() => {
  state.reads += 1;
  return state.reads === 1
    ? AsyncResult.fail(new Error("offline"))
    : AsyncResult.success({
        groups: [
          {
            taskId: "task-1",
            truncated: false,
            children: [
              {
                childWorkId: "sub",
                ownerId: "owner",
                taskId: "task-1",
                generation: 1,
                surface: "delegate_remote",
                callerThreadId: "caller",
                requestKey: "request",
                promptDigest: "digest",
                state: "unknown",
                destination: { host: "recovered host" },
                createdAt: "2026-11-04T00:00:00.000Z",
                updatedAt: "2026-11-04T00:00:00.000Z",
              },
            ],
          },
        ],
      });
});

const decodeRemoteWork = Schema.decodeSync(BotRemoteWork);
const decodeLookupWork = Schema.decodeUnknownSync(BotWorkResult);
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
  decodeRemoteWork({
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

function setup(connected: string[] = []) {
  state.connected = new Set(connected);
  state.supported = false;
  state.reads = 0;
}

const details = () => (
  <GoatBotWorkDetails
    environmentId={EnvironmentId.make("env-studio")}
    taskId={ChannelTaskId.make("task-1")}
    rows={rows}
    remoteWork={remoteWork}
  />
);

it("opens a chore on another machine in that machine, and says when it is unavailable", async () => {
  setup(["env-macbook"]);
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

it.each(["failed", "cancelled", "released"] as const)(
  "shows an ended remote launch as %s without a link",
  async (remoteState) => {
    setup();
    const item = decodeRemoteWork({
      childWorkId: "ended",
      taskId: "task-1",
      callerThreadId: "channel-worker:task-1",
      host: "remote",
      state: remoteState,
      lastActivityAt: at,
      workKind: "chore",
    });
    await using screen = await render(
      <GoatBotWorkDetails
        environmentId={EnvironmentId.make("env-studio")}
        taskId={ChannelTaskId.make("task-1")}
        rows={rows}
        remoteWork={[item]}
      />,
    );
    await expect
      .element(
        screen.getByText(
          remoteState === "failed"
            ? /Failed/
            : remoteState === "cancelled"
              ? /Cancelled/
              : /Not started/,
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
  },
);

it("retries a failed sub-work read and shows the returned subagent", async () => {
  setup();
  state.supported = true;
  await using screen = await render(details());
  await expect.element(screen.getByText("Couldn't load subagents.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await expect.element(screen.getByText(/recovered host/)).toBeVisible();
  expect(state.reads).toBe(2);
});

it("shows lookup coding and remote work even when the task view is unavailable", async () => {
  setup(["env-macbook"]);
  const work = decodeLookupWork({
    task: {
      state: "unavailable",
      task: { taskId: "task-1", title: "Older work", status: "running", updatedAt: at },
    },
    codingRows: [
      {
        kind: "coding",
        taskId: "task-1",
        environmentId: "env-studio",
        threadId: "code-1",
        title: "Local work",
        state: "bound",
        lastActivityAt: at,
      },
    ],
    remoteWork,
    launchesTruncated: false,
    partial: true,
  });
  await using screen = await render(<GoatBotUnavailableWork work={work} />);
  await userEvent.click(screen.getByText("Show work"));
  await expect
    .element(screen.getByRole("link", { name: "Local work" }))
    .toHaveAttribute("href", "/env-studio/code-1");
  await expect
    .element(screen.getByRole("link", { name: "Open work thread on macbookpro2" }))
    .toHaveAttribute("href", "/env-macbook/restart-3774");
});
