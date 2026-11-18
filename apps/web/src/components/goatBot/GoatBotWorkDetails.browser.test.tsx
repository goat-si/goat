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

const state = vi.hoisted(() => ({
  connected: new Set<string>(),
  supported: false,
  reads: 0,
  shellTitles: {} as Record<string, string>,
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref && state.shellTitles[ref.threadId] ? { title: state.shellTitles[ref.threadId] } : null,
}));
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
const decodeRow = Schema.decodeSync(BotThreadRow);
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
  state.shellTitles = {};
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

const studio = EnvironmentId.make("env-studio");
const taskWithThreads = [
  Schema.decodeSync(BotThreadRow)({
    kind: "task",
    task: { taskId: "task-1", title: "Restart the 3774 server", status: "running", updatedAt: at },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    worker: { environmentId: "env-studio", threadId: "worker-1" },
  }),
  ...(
    [
      ["coding-a", "Fix the build"],
      ["coding-b", "Write the release notes for the port 3774 restart and its rollback plan"],
      ["coding-c", undefined],
    ] as ReadonlyArray<readonly [string, string | undefined]>
  ).map(([threadId, title]) =>
    decodeRow({
      kind: "coding",
      taskId: "task-1",
      environmentId: "env-studio",
      threadId,
      ...(title ? { title } : {}),
      state: "bound",
      lastActivityAt: at,
    }),
  ),
];
const hrefOf = (screen: Awaited<ReturnType<typeof render>>, name: string) =>
  screen.getByRole("link", { name, exact: true }).element().getAttribute("href");

it("names each coding link by its thread title; the worker and an untitled thread say Open work thread", async () => {
  setup();
  const link = (threadId: string, kind: "worker" | "coding") => ({
    taskId: ChannelTaskId.make("task-1"),
    environmentId: studio,
    threadId: threadId as never,
    kind,
  });
  await using screen = await render(
    <GoatBotWorkDetails
      environmentId={studio}
      taskId={ChannelTaskId.make("task-1")}
      rows={taskWithThreads}
      remoteWork={[]}
      currentLinks={[
        link("worker-1", "worker"),
        link("coding-a", "coding"),
        link("coding-b", "coding"),
        link("coding-c", "coding"),
      ]}
      currentRemoteIds={[]}
    />,
  );
  await expect.element(screen.getByRole("link", { name: "Fix the build" })).toBeVisible();
  expect(hrefOf(screen, "Fix the build")).toBe("/env-studio/coding-a");
  // A long title is cut on screen; the link's name keeps all of it.
  expect(
    hrefOf(screen, "Write the release notes for the port 3774 restart and its rollback plan"),
  ).toBe("/env-studio/coding-b");
  const fallbacks = screen
    .getByRole("link", { name: "Open work thread", exact: true })
    .elements()
    .map((element) => element.getAttribute("href"));
  expect(fallbacks).toEqual(["/env-studio/worker-1", "/env-studio/coding-c"]);
});

it("names coding links by title where Home does not govern too", async () => {
  setup();
  await using screen = await render(
    <GoatBotWorkDetails
      environmentId={studio}
      taskId={ChannelTaskId.make("task-1")}
      rows={taskWithThreads}
      remoteWork={[]}
    />,
  );
  await expect.element(screen.getByRole("link", { name: "Fix the build" })).toBeVisible();
  expect(hrefOf(screen, "Fix the build")).toBe("/env-studio/coding-a");
});

it("tells two launches on the same machine apart by their thread titles", async () => {
  setup(["env-macbook"]);
  state.shellTitles = { "restart-3774": "Restart 3774", "restart-3775": "Restart 3775" };
  const second = decodeRemoteWork({
    childWorkId: "cw-restart-2",
    taskId: "task-1",
    callerThreadId: "channel-worker:task-1",
    host: "macbookpro2",
    state: "bound",
    lastActivityAt: at,
    threadId: "restart-3775",
    environmentId: "env-macbook",
    workKind: "chore",
  });
  await using screen = await render(
    <GoatBotWorkDetails
      environmentId={studio}
      taskId={ChannelTaskId.make("task-1")}
      rows={rows}
      remoteWork={[...remoteWork, second]}
    />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Restart 3774 on macbookpro2" }))
    .toHaveAttribute("href", "/env-macbook/restart-3774");
  await expect
    .element(screen.getByRole("link", { name: "Restart 3775 on macbookpro2" }))
    .toHaveAttribute("href", "/env-macbook/restart-3775");
});

const codingRows = (titles: ReadonlyArray<readonly [string, string]>) => [
  taskWithThreads[0]!,
  ...titles.map(([threadId, title]) =>
    decodeRow({
      kind: "coding",
      taskId: "task-1",
      environmentId: "env-studio",
      threadId,
      title,
      state: "bound",
      lastActivityAt: at,
    }),
  ),
];
const legacyDetails = (detailRows: readonly BotThreadRow[]) => (
  <GoatBotWorkDetails
    environmentId={studio}
    taskId={ChannelTaskId.make("task-1")}
    rows={detailRows}
    remoteWork={[]}
  />
);
const hrefsNamed = (screen: Awaited<ReturnType<typeof render>>, name: string) =>
  screen
    .getByRole("link", { name, exact: true })
    .elements()
    .map((element) => element.getAttribute("href"));

it("a coding thread titled only with spaces reads Open work thread", async () => {
  setup();
  await using screen = await render(legacyDetails(codingRows([["coding-blank", "   "]])));
  await expect.element(screen.getByRole("link", { name: "Open work thread" }).nth(1)).toBeVisible();
  expect(hrefsNamed(screen, "Open work thread")).toEqual([
    "/env-studio/worker-1",
    "/env-studio/coding-blank",
  ]);
});

it("a launch whose thread title is only spaces reads Open work thread on its host", async () => {
  setup(["env-macbook"]);
  state.shellTitles = { "restart-3774": "   " };
  await using screen = await render(details());
  await expect
    .element(screen.getByRole("link", { name: "Open work thread on macbookpro2" }))
    .toHaveAttribute("href", "/env-macbook/restart-3774");
});

it("two coding threads with the same title both show, each opening its own thread", async () => {
  setup();
  await using screen = await render(
    legacyDetails(
      codingRows([
        ["coding-1", "Fix the build"],
        ["coding-2", "Fix the build"],
      ]),
    ),
  );
  await expect.element(screen.getByRole("link", { name: "Fix the build" }).nth(1)).toBeVisible();
  expect(hrefsNamed(screen, "Fix the build")).toEqual([
    "/env-studio/coding-1",
    "/env-studio/coding-2",
  ]);
});

it("a coding thread titled like its task keeps that title", async () => {
  setup();
  await using screen = await render(
    legacyDetails(codingRows([["coding-same", "Restart the 3774 server"]])),
  );
  await expect
    .element(screen.getByRole("link", { name: "Restart the 3774 server" }))
    .toHaveAttribute("href", "/env-studio/coding-same");
});
