import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
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
vi.mock("../../state/channels", () => ({ channelEnvironment: { botStatus: () => "status" } }));
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
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(catalog.atom!, listed(["env"]));
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  function Probe() {
    value = useMobileMemberStatus(bot);
    return null;
  }
  // The roster's own bot-list read, which says whether this phone may still read the computer.
  function BotList(props: { readonly cause: unknown }) {
    useKeptPerComputer(
      "bots",
      EnvironmentId.make("env"),
      {
        data: props.cause === null ? botList : null,
        successResult: null,
        cause: props.cause,
        error: null,
        isPending: false,
        isSuccess: props.cause === null,
        refresh: () => {},
      },
      !member.connected,
    );
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
    show: (botListCause: unknown = null) =>
      act(async () =>
        root.render(
          view(
            <>
              <BotList cause={botListCause} />
              <Probe />
            </>,
          ),
        ),
      ),
    setComputers: (ids: string[]) => act(async () => registry.set(catalog.atom!, listed(ids))),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      stop();
    },
  };
}
const botList = { bots: [] };
const reply = {
  text: "Which machine should I check?",
  at: "2026-11-11T10:05:00.000Z",
  author: "bot" as const,
};

it("keeps a member's last line and waiting count while its computer is offline, without its running work", async () => {
  setup();
  member.answer = { waitingCount: 2, latest: reply, tasks: { active: true } };
  await using row = rosterRow();
  await row.show();
  member.connected = false;
  await row.show();
  expect(row.value?.latest).toEqual(reply);
  expect(row.value?.waitingCount).toBe(2);
  expect(row.value?.kept).toBe(true);
  // An old count is not a fresh one, and the work it saw going may have stopped since.
  expect(row.value?.waitingState).toBe("pending");
  expect(row.value?.status?.tasks).toBeUndefined();
});

it("a member's status read refused for access shows nothing of the earlier answer it still holds", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show();
  expect(row.value?.latest).toEqual(reply);
  member.cause = refused;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
  expect(row.value?.waitingCount).toBe(0);
  member.connected = false;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
});

it("a refused bot list leaves no member status kept, offline or after", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show();
  await row.show(refused);
  member.connected = false;
  await row.show(refused);
  expect(row.value?.latest).toBeUndefined();
  expect(row.value?.waitingCount).toBe(0);
});

it("a member's kept status goes with its computer, and adding the computer again starts empty", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show();
  member.connected = false;
  await row.setComputers([]);
  await row.show();
  expect(row.value?.latest).toBeUndefined();
  await row.setComputers(["env"]);
  await row.show();
  expect(row.value?.latest).toBeUndefined();
});

it("keeps nothing for a deleted member", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  const deleted = { ...scout, state: "deleted" } as typeof scout;
  await using row = rosterRow(deleted);
  await row.show();
  member.connected = false;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
});

it("a member's kept status is gone once its computer refuses this phone, and does not come back", async () => {
  setup();
  member.answer = { waitingCount: 1, latest: reply };
  await using row = rosterRow();
  await row.show();
  member.connected = false;
  member.failure = { kind: "blocked", reason: "authentication" };
  await row.show();
  expect(row.value?.latest).toBeUndefined();
  expect(row.value?.waitingCount).toBe(0);
  // The refusal is forgotten (say the phone is paired again) while still offline: what was kept is gone.
  member.failure = null;
  await row.show();
  expect(row.value?.latest).toBeUndefined();
});
