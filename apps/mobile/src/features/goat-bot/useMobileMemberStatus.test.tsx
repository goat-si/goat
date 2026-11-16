import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const member = vi.hoisted(() => ({
  shell: null as null | { updatedAt: string; lastVisitedAt?: string | null },
  latest: undefined as undefined | { text: string; at: string; author: "bot" | "person" },
  refresh: vi.fn(),
  // A refresh that failed after an earlier answer: the query keeps that answer beside the error.
  error: null as string | null,
  capabilities: {} as Record<string, boolean>,
  connected: true,
  // What the status read answers; offline it reads nothing.
  answer: null as null | object,
  cause: null as unknown,
  failure: null as null | { kind: string; reason: string },
  // The bots the roster's list answers with; a deleted one is listed with its state.
  listed: [{ botId: "scout" }] as ReadonlyArray<{ botId: string; state?: string }>,
  // Open asks, kept per computer for offline, and whether their reader is on screen.
  asks: { asks: [{ text: "Which machine?" }], total: 1 } as object,
  asksShown: false,
}));
const visitAware = {
  goatBotMembers: true,
  goatBotStatus: true,
  goatBotWaitingRead: true,
  threadVisitedTracking: true,
};
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection:
            member.failure !== null
              ? { phase: "error", failure: member.failure }
              : { phase: member.connected ? "connected" : "disconnected" },
          serverConfig: {
            environment: { capabilities: { ...visitAware, ...member.capabilities } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: { botStatus: () => "status", listBots: () => null },
}));
// The presentations the follower watches; each show sets the computer's connection.
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    // Like a real read, an answer keeps its identity; a refused one keeps the earlier answer beside it.
    member.answer ??= { waitingCount: 0, ...(member.latest ? { latest: member.latest } : {}) };
    const data = query === null ? null : member.answer;
    return {
      data,
      successResult: data !== null && member.cause === null ? { value: data } : null,
      cause: query === null ? null : member.cause,
      error: member.error,
      isPending: false,
      isSuccess: data !== null && member.cause === null,
      refresh: member.refresh,
    };
  },
}));
// The app's computers; "env" is listed unless a test removes it.
const catalog = vi.hoisted(() => ({
  atom: null as null | import("effect/reactivity").Atom.Writable<unknown>,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  catalog.atom = Atom.make<unknown>({ isReady: true, entries: new Map([["env", {}]]) });
  return { environmentCatalog: { catalogValueAtom: catalog.atom } };
});
vi.mock("../../state/entities", () => ({ useThreadShell: () => member.shell }));

import { environmentPresentations } from "../../state/presentation";
import { useMobileMemberStatus } from "./useMobileMemberStatus";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useKeptPerComputer,
} from "./useKeptPerComputer";

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "scout-thread",
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
});

function setup() {
  member.shell = null;
  member.latest = undefined;
  member.refresh.mockClear();
  member.error = null;
  member.capabilities = {};
  member.connected = true;
  member.answer = null;
  member.cause = null;
  member.failure = null;
  member.listed = [{ botId: "scout" }];
  member.asksShown = false;
  resetKeptPerComputerForTests();
}

async function unread() {
  let value: boolean | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout).unread;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  return value;
}

it("marks a member's reply unread until a visit of its conversation reaches it", async () => {
  setup();
  member.latest = { text: "Which machine?", at: "2026-11-11T10:05:00.000Z", author: "bot" };
  member.shell = {
    updatedAt: "2026-11-11T10:05:00.000Z",
    lastVisitedAt: "2026-11-11T10:01:00.000Z",
  };
  expect(await unread()).toBe(true);
  // The member's chat recorded the visit at its newest message.
  member.shell = {
    updatedAt: "2026-11-11T10:05:00.000Z",
    lastVisitedAt: "2026-11-11T10:05:00.000Z",
  };
  expect(await unread()).toBe(false);
});

it("never marks a member unread on a server that records no visits", async () => {
  setup();
  member.latest = { text: "Hi, I'm Scout.", at: "2026-11-11T10:05:00.000Z", author: "bot" };
  member.shell = { updatedAt: "2026-11-11T10:05:00.000Z" };
  expect(await unread()).toBe(false);
});

it("a waiting count whose latest read failed is unavailable, not the earlier answer", async () => {
  setup();
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout);
    return null;
  }
  const show = async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
  };
  member.error = null;
  await show();
  expect(value?.waitingState).toBe("ready");
  member.error = "failed";
  await show();
  expect(value?.waitingState).toBe("unavailable");
});

it("a waiting count from a server that cannot count by visit is unavailable", async () => {
  setup();
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout);
    return null;
  }
  for (const missing of ["goatBotStatus", "goatBotWaitingRead", "threadVisitedTracking"]) {
    member.capabilities = { [missing]: false };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    expect(value?.waitingState, missing).toBe("unavailable");
  }
});

const refused = { _tag: "EnvironmentAuthorizationError", message: "Not allowed." };
const listed = (ids: string[]) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});

/** Renders Scout's row status in one registry that follows the app's computers, as the app does. */
function rosterRow(bot = scout) {
  const registry = AtomRegistry.make();
  const connections = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
    ReadonlyMap<string, object>
  >;
  const stop = followKeptPerComputerCatalog(registry, connections as never);
  registry.set(catalog.atom!, listed(["env"]));
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  let asks: unknown = null;
  // Needs you's own kept read of the computer's open asks.
  function Asks() {
    const live = member.connected ? member.asks : null;
    asks = useKeptPerComputer("asks", EnvironmentId.make("env"), {
      data: live,
      successResult: null,
      cause: null,
      error: null,
      isPending: false,
      isSuccess: live !== null,
      refresh: () => {},
    });
    return null;
  }
  function Probe(props: { readonly bot: typeof scout }) {
    value = useMobileMemberStatus(props.bot);
    return null;
  }
  // The roster's own bot-list read, which says whether this phone may still read the computer.
  function BotList(props: { readonly cause: unknown }) {
    useKeptPerComputer("bots", EnvironmentId.make("env"), {
      // As in the app, a bot list reads nothing while its computer is offline or refuses it.
      data: props.cause === null && member.connected ? listOf(member.listed) : null,
      successResult: null,
      cause: props.cause,
      error: null,
      isPending: false,
      isSuccess: props.cause === null && member.connected,
      refresh: () => {},
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const view = (children: ReactNode) => (
    <RegistryContext value={registry}>{children}</RegistryContext>
  );
  return {
    get value() {
      return value;
    },
    get asks() {
      return asks;
    },
    show: (botListCause: unknown = null, shown: typeof scout | null = bot) =>
      act(async () => {
        registry.set(
          connections,
          new Map([
            [
              "env",
              {
                connection:
                  member.failure === null
                    ? { phase: member.connected ? "connected" : "disconnected" }
                    : { phase: "error", failure: member.failure },
              },
            ],
          ]),
        );
        root.render(
          view(
            <>
              <BotList cause={botListCause} />
              {shown === null ? null : <Probe bot={shown} />}
              {member.asksShown ? <Asks /> : null}
            </>,
          ),
        );
      }),
    setComputers: (ids: string[]) => act(async () => registry.set(catalog.atom!, listed(ids))),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      stop();
    },
  };
}
// One answer per listed set, so an unchanged list keeps its identity as a real read does.
const lists = new Map<string, object>();
const listOf = (listed: ReadonlyArray<{ botId: string; state?: string }>) => {
  const key = JSON.stringify(listed);
  let list = lists.get(key);
  if (list === undefined)
    lists.set(key, (list = { bots: listed.map((bot) => ({ ...scout, ...bot })) }));
  return list;
};
const reply = {
  text: "Which machine should I check?",
  at: "2026-11-11T10:05:00.000Z",
  author: "bot" as const,
};

it("offline, a member's row shows no line or waiting count from before", async () => {
  setup();
  member.answer = { waitingCount: 2, latest: reply, tasks: { active: true } };
  await using row = rosterRow();
  await row.show();
  expect(row.value?.latest).toEqual(reply);
  member.connected = false;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
  expect(row.value?.waitingCount).toBe(0);
  expect(row.value?.status).toBeNull();
});

it("a member's status read refused for access shows nothing of the earlier answer it still holds", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show();
  expect(row.value?.latest).toEqual(reply);
  expect(row.value?.unreadable).toBe(false);
  member.cause = refused;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
  expect(row.value?.waitingCount).toBe(0);
  expect(row.value?.unreadable).toBe(true);
});

it("a member is unreadable once its bot list is refused, and once its computer refuses this phone", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show(refused);
  expect(row.value?.unreadable).toBe(true);
  await row.show();
  expect(row.value?.unreadable).toBe(false);
  member.connected = false;
  member.failure = { kind: "blocked", reason: "authentication" };
  await row.show();
  expect(row.value?.unreadable).toBe(true);
});

it("a refused bot list forgets the open asks kept for its computer, on screen or not", async () => {
  setup();
  member.asksShown = true;
  await using row = rosterRow();
  await row.show();
  expect(row.asks).not.toBeNull();
  // Needs you leaves the screen; then the bot list is refused, then answers again.
  member.asksShown = false;
  await row.show(null, null);
  await row.show(refused, null);
  await row.show(null, null);
  member.connected = false;
  member.asksShown = true;
  await row.show();
  expect(row.asks).toBeNull();
});
