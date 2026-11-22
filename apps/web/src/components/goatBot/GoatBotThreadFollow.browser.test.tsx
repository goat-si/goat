import { ChannelTaskId, EnvironmentId, ThreadId, type BotThreadRow } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  show: vi.fn(),
  roster: vi.fn(),
  work: vi.fn(),
  follow: vi.fn(),
  followCapability: undefined as boolean | undefined,
  canOperate: false,
  update: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  refresh: vi.fn(),
  permit: true,
  current: { eligible: false, list: "pending", links: [] } as {
    eligible: boolean;
    list: string;
    links: unknown[];
    work?: unknown;
  },
  children: [] as unknown[],
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) => (atom === "current" ? actions.current : actions.permit),
}));
vi.mock("~/localApi", () => {
  const api = () => ({ contextMenu: { show: actions.show } });
  return { readLocalApi: api, ensureLocalApi: api };
});
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    readBotRoster: { label: "list bots", run: actions.roster },
    listBotThreadsPage: { label: "list work", run: actions.work },
    followThread: { label: "follow", permissionAtom: () => Atom.make(true), run: actions.follow },
    stopFollowingThread: { permissionAtom: () => "permission", execute: actions.update },
    updateTaskView: { permissionAtom: () => "permission", execute: actions.update },
    snoozeBotTask: { permissionAtom: () => "permission", execute: actions.snooze },
    unsnoozeBotTask: { permissionAtom: () => "permission", execute: actions.unsnooze },
    listChildWork: () => null,
    remoteWorkOpenable: () => "openable",
    homeCurrentOpenableWorkAtom: () => "current",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof actions.update }) => command.execute,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => null,
  readEnvironment: () => ({
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { goatBotThreadFollows: actions.followCapability } },
    },
  }),
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  readEnvironmentScope: () => actions.canOperate,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { groups: actions.children },
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  }),
}));

import { GoatBotHomeWork } from "./GoatBotHomeWork";
import { openWebThreadFollowMenu, webThreadFollowAvailable } from "./goatBotThreadFollowMenu";

const environmentId = EnvironmentId.make("env");

type Row = Extract<BotThreadRow, { kind: "task" }>;

function taskRow(
  taskId: string,
  title: string,
  status: string,
  at: string,
  extra: { unread?: boolean; doneAt?: string | null } = {},
): Row {
  return {
    kind: "task",
    task: { taskId, title, status, updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: extra.doneAt ?? null, readThrough: null },
    lastActivityAt: at,
    unread: extra.unread ?? false,
    mainMessagesSinceQuiet: 0,
  } as unknown as Row;
}

function setup(rows: Row[] = []) {
  actions.permit = true;
  actions.followCapability = undefined;
  actions.canOperate = false;
  actions.roster.mockReset();
  actions.work.mockReset();
  actions.follow.mockReset();
  actions.current = { eligible: false, list: "pending", links: [] };
  actions.children = [];
  actions.show.mockReset();
  actions.show.mockResolvedValue(null);
  actions.update.mockReset();
  actions.update.mockResolvedValue({ _tag: "Success" });
  actions.snooze.mockReset();
  actions.snooze.mockResolvedValue({ _tag: "Success" });
  actions.unsnooze.mockReset();
  actions.unsnooze.mockResolvedValue({ _tag: "Success" });
  actions.refresh.mockReset();
  return rows;
}

function view(rows: readonly Row[], overrides: Record<string, unknown> = {}) {
  return (
    <GoatBotHomeWork
      environmentId={environmentId}
      threadId={ThreadId.make("bot")}
      botName="GOAT Bot"
      rows={rows}
      remoteWork={[]}
      loaded
      failed={false}
      failure={null}
      onRetry={actions.refresh}
      onOpenTask={() => {}}
      showAll={false}
      onShowAllChange={() => {}}
      {...overrides}
    />
  );
}

it("follows from the thread menu, shows the work in Home, and stops following", async () => {
  setup();
  actions.followCapability = true;
  actions.canOperate = true;
  const threadId = ThreadId.make("release");
  const target = { environmentId, threadId };
  const row = {
    ...target,
    taskId: ChannelTaskId.make("release-task"),
    status: "running",
    pullRequest: "https://github.com/goat-si/goat/pull/3813",
  };
  actions.roster.mockResolvedValue(
    AsyncResult.success({
      bots: [
        { botId: "main", role: "main", name: "Scout", hidden: false, sessionThreadId: "bot" },
        {
          botId: "hidden",
          role: "member",
          name: "Hidden",
          hidden: true,
          sessionThreadId: "hidden-bot",
        },
      ],
    }),
  );
  actions.work.mockResolvedValue(
    AsyncResult.success({
      rows: [taskRow(row.taskId, "Prepare release", "running", "2026-11-09T00:00:00.000Z")],
    }),
  );
  actions.show.mockResolvedValueOnce("main").mockResolvedValueOnce(row.taskId);
  function ThreadAndHome() {
    const [followedThreads, setFollowedThreads] = useState<Array<typeof row>>([]);
    return (
      <>
        {webThreadFollowAvailable(target) && (
          <button
            type="button"
            onClick={async () => {
              await openWebThreadFollowMenu(target, "follow");
              if (actions.follow.mock.calls.length > 0) setFollowedThreads([row]);
            }}
          >
            Ask a bot to follow…
          </button>
        )}
        {view([], { followedThreads, onRetry: () => setFollowedThreads([]) })}
      </>
    );
  }
  actions.follow.mockResolvedValue(AsyncResult.success(true));
  await using screen = await render(<ThreadAndHome />);
  await userEvent.click(screen.getByRole("button", { name: "Ask a bot to follow…" }));
  await expect.element(screen.getByText("Followed threads", { exact: true })).toBeVisible();
  expect(actions.show.mock.calls[0]?.[0]).toContainEqual({ id: "main", label: "Scout" });
  expect(actions.show.mock.calls[0]?.[0]).not.toContainEqual({ id: "hidden", label: "Hidden" });
  expect(actions.follow).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: { ...target, botId: "main", taskId: row.taskId },
  });
  await expect.element(screen.getByText("running", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/3813/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Stop following" }));
  expect(actions.update).toHaveBeenCalledWith({
    environmentId,
    input: { botId: "main", environmentId, threadId },
  });
  await expect
    .element(screen.getByText("Followed threads", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Ask a bot to follow…" })).toBeVisible();
});
