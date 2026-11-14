import { EnvironmentId, ThreadId, type BotProfile } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { Profiler, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { act, render } from "../../../test/render";

// The conversation as two entity hooks give it: live items change with every streamed token,
// timeline items hold while only streamed assistant text moves (threadDetail.test.ts covers that).
const stream = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    live: [] as ReadonlyArray<unknown>,
    held: [] as ReadonlyArray<unknown>,
    counts: { homeRenders: 0, panelRenders: 0, turnScans: 0, cardScans: 0 },
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    environment: {
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: {
            goatBotTaskThreads: true,
            goatBotMembers: true,
            goatBotProfileEdit: true,
          },
        },
      },
    },
    threads: {
      data: {
        mainMessageCount: 0,
        remoteWork: [],
        rows: [
          {
            kind: "task",
            task: {
              taskId: "task-a",
              title: "Fix the build",
              status: "running",
              updatedAt: "2026-11-09T00:00:00.000Z",
            },
            view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
            lastActivityAt: "2026-11-09T00:00:00.000Z",
            unread: false,
            mainMessagesSinceQuiet: 0,
          },
        ],
      },
      error: null,
      failure: null,
      isSuccess: true,
      isPending: false,
      refresh: () => {},
    },
    routines: {
      data: { tasks: [] },
      error: null,
      failure: null,
      isSuccess: true,
      isPending: false,
      refresh: () => {},
    },
  };
});
vi.mock("@goat/client-runtime/goatBot", async (original) => {
  const real = await original<typeof import("@goat/client-runtime/goatBot")>();
  return {
    ...real,
    // GoatBotHomeWork groups its rows once per render, so this counts Home's renders.
    botHomeWork: (...args: Parameters<typeof real.botHomeWork>) => {
      stream.counts.homeRenders += 1;
      return real.botHomeWork(...args);
    },
    // useBotThreads reads the conversation for the bot's own questions and its task cards.
    goatBotTurnsWaiting: (...args: Parameters<typeof real.goatBotTurnsWaiting>) => {
      stream.counts.turnScans += 1;
      return real.goatBotTurnsWaiting(...args);
    },
    goatBotNewestTaskChips: (...args: Parameters<typeof real.goatBotNewestTaskChips>) => {
      stream.counts.cardScans += 1;
      return real.goatBotNewestTaskChips(...args);
    },
  };
});
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadShell: () => null,
  useServerConfigs: () => new Map(),
  useThreadVisibleTurnItems: (ref: unknown) =>
    useSyncExternalStore(stream.subscribe, () => (ref === null ? [] : stream.live)),
  useTimelineVisibleTurnItems: (ref: unknown) =>
    useSyncExternalStore(stream.subscribe, () => (ref === null ? [] : stream.held)),
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => stream.environment,
}));
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: unknown) => (atom === "threads" ? stream.threads : stream.routines),
}));
vi.mock("~/state/server", async (original) => {
  const real = await original<typeof import("~/state/server")>();
  return {
    ...real,
    serverEnvironment: {
      ...real.serverEnvironment,
      scheduledTasksLive: () => null,
      upsertScheduledTask: { permissionAtom: () => Atom.make(false), execute: vi.fn() },
      setScheduledTaskEnabled: { permissionAtom: () => Atom.make(false), execute: vi.fn() },
      runScheduledTaskNow: { permissionAtom: () => Atom.make(false), execute: vi.fn() },
    },
  };
});
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("./GoatBotAvatar", async (original) => ({
  ...(await original<typeof import("./GoatBotAvatar")>()),
  GoatBotSessionAvatar: () => <span data-goat-session-avatar />,
}));
vi.mock("./useGoatBotMemberStatus", () => ({
  useGoatBotMemberWaitingCount: () => 0,
  useGoatBotMemberStatus: () => ({ waitingCount: 0, latest: undefined }),
}));
vi.mock("./GoatBotSuggested", () => ({ GoatBotSuggested: () => null }));
vi.mock("./GoatBotComputer", () => ({ GoatBotComputer: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBotThreads: () => "threads",
    listBotThreadsPage: { execute: vi.fn() },
    updateBot: { permissionAtom: () => Atom.make(false) },
    updateTaskView: { permissionAtom: () => Atom.make(true), execute: vi.fn() },
    listChildWork: () => null,
    remoteWorkOpenable: () => Atom.make(false),
    homeCurrentOpenableWorkAtom: () => Atom.make({ eligible: false, list: "pending", links: [] }),
  },
}));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";
import { GoatBotMemberContext } from "./goatBotMemberContext";

const member = {
  botId: "scout",
  role: "member",
  name: "Scout",
  environmentId: EnvironmentId.make("env"),
  sessionThreadId: ThreadId.make("bot"),
  state: "active",
} as unknown as BotProfile;

const chip = (taskVersion: number, needsYou: ReadonlyArray<{ kind: string }> = []) => ({
  sourceItemId: "chip-a",
  item: {
    type: "notification",
    updatedAt: "2026-11-09T00:00:00.000Z",
    ledgerTask: {
      taskId: "task-a",
      taskVersion,
      status: "running",
      openQuestionCount: 0,
      observed: {
        pullRequests: [],
        needsYou: needsYou.map((need) => ({ ...need, since: "2026-11-09T00:00:00.000Z" })),
      },
    },
  },
});
const reply = (text: string) => ({
  sourceItemId: "reply-1",
  item: {
    type: "assistant_message",
    text,
    streaming: true,
    updatedAt: "2026-11-09T00:00:00.000Z",
  },
});

function setup() {
  stream.live = [chip(1)];
  stream.held = stream.live;
  stream.counts = { homeRenders: 0, panelRenders: 0, turnScans: 0, cardScans: 0 };
}

async function emit(live: ReadonlyArray<unknown>, held: ReadonlyArray<unknown> = stream.held) {
  await act(() => {
    stream.live = live;
    stream.held = held;
    for (const listener of stream.listeners) listener();
  });
}

const noop = () => {};
const rowsFrom = (live: ReadonlyArray<unknown>) => (live.length < 0 ? [] : []);

/** Counts from here on: what each streamed token costs. */
function since() {
  const at = { ...stream.counts };
  return () => ({
    homeRenders: stream.counts.homeRenders - at.homeRenders,
    panelRenders: stream.counts.panelRenders - at.panelRenders,
    turnScans: stream.counts.turnScans - at.turnScans,
    cardScans: stream.counts.cardScans - at.cardScans,
  });
}

async function streamReply() {
  let text = "";
  for (const token of ["Look", "ing", " into", " the", " build"]) {
    text += token;
    await emit([chip(1), reply(text)]);
  }
  return text;
}

// Each commit of the panel's tree, whatever inside it rendered.
const countPanelRender = () => {
  stream.counts.panelRenders += 1;
};

function Home({ peekRows }: { readonly peekRows: () => ReadonlyArray<never> }) {
  return (
    <GoatBotMemberContext value={member}>
      <Profiler id="home" onRender={countPanelRender}>
        <GoatBotWorkPanel
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("bot")}
          onOpenFile={noop}
          onClose={noop}
          peekRows={peekRows}
        />
      </Profiler>
    </GoatBotMemberContext>
  );
}

const stillRows = () => [];

/** The chat beside Home, whose task rows close over the live conversation as the session's do. */
function ChatWithHome() {
  const live = useSyncExternalStore(stream.subscribe, () => stream.live);
  return <Home peekRows={() => rowsFrom(live)} />;
}

it("performance invariant: a streamed reply neither re-renders Home nor rescans the conversation, and a new task card version still updates its row", async () => {
  setup();
  await using screen = await render(<ChatWithHome />);
  const row = screen.getByRole("button", { name: /^Fix the build/ });
  await expect.element(row).toMatchTextContent(/Working/);
  expect(stream.counts.homeRenders).toBeGreaterThan(0);
  const cost = since();
  const text = await streamReply();
  expect(cost()).toMatchObject({ homeRenders: 0, turnScans: 0, cardScans: 0 });
  const asked = [chip(2, [{ kind: "question" }]), reply(text)];
  await emit(asked, asked);
  await expect.element(row).toMatchTextContent(/Waiting for your answer/);
});

it("performance invariant: a streamed reply does not re-render the panel through the bot's task list", async () => {
  setup();
  await using screen = await render(<Home peekRows={stillRows} />);
  await expect
    .element(screen.getByRole("button", { name: /^Fix the build/ }))
    .toMatchTextContent(/Working/);
  const cost = since();
  await streamReply();
  expect(cost()).toEqual({ homeRenders: 0, panelRenders: 0, turnScans: 0, cardScans: 0 });
});
