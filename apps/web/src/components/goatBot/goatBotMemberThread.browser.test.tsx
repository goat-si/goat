import { forgetNewBotEnvironment, newBotSlot, startNewBot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useRef, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const server = vi.hoisted(() => ({
  presentation: null as null | object,
  query: { data: null, error: null, isPending: false } as {
    data: null | { bots: unknown[] };
    error: string | null;
    isPending: boolean;
  },
  listed: [] as unknown[],
  /** The bot list as the atom registry holds it, which a rename watches for its next read. */
  list: null as unknown,
  update: (_input: unknown): Promise<unknown> => Promise.resolve({}),
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => server.presentation,
}));
vi.mock("~/state/channels", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const list = Atom.make(AsyncResult.initial<{ bots: unknown[] }, unknown>());
  server.list = list;
  return {
    channelEnvironment: {
      listBots: (args: { readonly input: unknown }) => {
        server.listed.push(args.input);
        return list;
      },
      updateBot: { permissionAtom: () => null },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => server.update(input),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === null
      ? { data: null, error: null, isPending: false, refresh: () => {} }
      : { ...server.query, refresh: () => {} },
}));

import { useGoatBotMemberAt } from "./goatBotMemberThread";
import type { GoatBotComposerHandle } from "./GoatBotComposer";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotNameRow } from "./GoatBotNameRow";
import { forgetRenamedBots } from "./goatBotRenamedBots";

const environmentId = EnvironmentId.make("env");
const memberThread = ThreadId.make("channel-member-bot:abc");
const decodeProfile = Schema.decodeSync(BotProfile);
const research = decodeProfile({
  botId: "research",
  role: "member",
  name: "Research",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId,
  sessionThreadId: memberThread,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});
const connected = (goatBotMembers: boolean | undefined) => ({
  connection: { phase: "connected" },
  serverConfig: { environment: { capabilities: { goatBotMembers } } },
});

/** No bot created or renamed by an earlier test, and a server that has not answered yet. */
function setup() {
  forgetNewBotEnvironment(environmentId);
  forgetRenamedBots(environmentId);
  server.presentation = null;
  server.query = { data: null, error: null, isPending: false };
  server.listed = [];
  server.update = () => Promise.resolve({});
}

function Lookup({ threadId }: { threadId: ThreadId }) {
  const result = useGoatBotMemberAt({ environmentId, threadId });
  return (
    <output data-retry={result.retry === null ? "none" : "list"}>
      {result.member?.name ??
        (result.unavailable ? "unavailable" : result.pending ? "pending" : "ordinary")}
    </output>
  );
}

async function look(threadId: ThreadId = memberThread) {
  await using screen = await render(<Lookup threadId={threadId} />, { router: false }); // A hook check.
  return screen.container.textContent;
}

it("decides when a thread may be a member's: wait, retry, the member, or an ordinary thread", async () => {
  setup();
  server.presentation = { connection: { phase: "connecting" } };
  expect(await look()).toBe("pending");
  server.presentation = { connection: { phase: "offline" } };
  expect(await look()).toBe("unavailable");
  {
    await using screen = await render(<Lookup threadId={memberThread} />, { router: false }); // A hook check.
    // Unreachable before capabilities: GOAT reconnects on its own, so there is nothing to retry.
    expect(screen.container.querySelector("output")?.dataset.retry).toBe("none");
  }
  server.presentation = connected(true);
  server.query = { data: null, error: null, isPending: true };
  expect(await look()).toBe("pending");
  expect(await look(ThreadId.make("ordinary"))).toBe("ordinary");
  server.query = { data: null, error: "Request failed", isPending: false };
  expect(await look()).toBe("unavailable");
  server.query = { data: { bots: [research] }, error: null, isPending: false };
  expect(await look()).toBe("Research");
  server.query = { data: { bots: [] }, error: null, isPending: false };
  expect(await look()).toBe("ordinary");
  server.presentation = connected(undefined);
  expect(await look()).toBe("ordinary");
});

it("finds a member this client just created when the list read after the create failed", async () => {
  setup();
  startNewBot(
    environmentId,
    [],
    async () => research,
    () => {},
    {},
    () => "request-1",
  );
  await vi.waitFor(() => expect(newBotSlot(environmentId).created).toHaveLength(1));
  server.presentation = connected(true);
  // The last good list, from before the create; the read after it failed.
  server.query = { data: { bots: [] }, error: "Request failed", isPending: false };
  expect(await look()).toBe("Research");
});

it("names the main chat from a server that keeps profiles but not members", async () => {
  setup();
  const main = decodeProfile({
    botId: "main",
    role: "main",
    name: "Goaty",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId,
    sessionThreadId: ThreadId.make("bot"),
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  server.presentation = {
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { goatBotProfiles: true } } },
  };
  server.query = { data: { bots: [main] }, error: null, isPending: false };
  function MainName(props: { readonly threadId: string; readonly main: boolean }) {
    const lookup = useGoatBotMemberAt(
      { environmentId, threadId: ThreadId.make(props.threadId) },
      props.main,
    );
    return <output>{lookup.main?.name}</output>;
  }
  {
    await using screen = await render(<MainName threadId="bot" main />, { router: false }); // A hook check.
    expect(screen.container.textContent).toBe("Goaty");
    // The roster's own list: without members it reads live bots only.
    expect(server.listed).toEqual([{}]);
  }
  // An ordinary coding thread never asks for the bot list on such a server.
  server.listed = [];
  {
    await using _ordinary = await render(<MainName threadId="ordinary" main={false} />, {
      router: false, // A hook check.
    });
    expect(server.listed).toEqual([]);
  }
  // Nor does the main thread while its computer is offline.
  server.presentation = {
    connection: { phase: "offline" },
    serverConfig: { environment: { capabilities: { goatBotProfiles: true } } },
  };
  {
    await using _offline = await render(<MainName threadId="bot" main />, { router: false }); // A hook check.
    expect(server.listed).toEqual([]);
  }
});
/** A member chat's title and name row, from the same lookup the thread route uses. */
function NamedChat() {
  const { member } = useGoatBotMemberAt({ environmentId, threadId: memberThread });
  const composer = useRef<GoatBotComposerHandle>(null);
  return (
    <GoatBotMemberContext value={member}>
      <h1 data-state={member?.state ?? "active"}>{member?.name ?? "No bot"}</h1>
      <GoatBotNameRow composer={composer} />
    </GoatBotMemberContext>
  );
}

type ListAnswer =
  | { readonly bots: ReadonlyArray<BotProfile> }
  | { readonly reading: ReadonlyArray<BotProfile> }
  | { readonly failed: ReadonlyArray<BotProfile> };

/** The bot list's state, both as the chat's query view and in the registry a rename watches. */
function answerList(registry: AtomRegistry.AtomRegistry, answer: ListAnswer) {
  const list = server.list as Atom.Writable<AsyncResult.AsyncResult<{ bots: unknown[] }, unknown>>;
  if ("bots" in answer) {
    server.query = { data: { bots: [...answer.bots] }, error: null, isPending: false };
    registry.set(list, AsyncResult.success({ bots: [...answer.bots] }));
  } else if ("reading" in answer) {
    server.query = { data: { bots: [...answer.reading] }, error: null, isPending: true };
    registry.set(list, AsyncResult.success({ bots: [...answer.reading] }, { waiting: true }));
  } else {
    server.query = {
      data: { bots: [...answer.failed] },
      error: "Request failed",
      isPending: false,
    };
    registry.set(
      list,
      AsyncResult.failure(Cause.fail(new Error("Request failed")), {
        previousSuccess: Option.some(AsyncResult.success({ bots: [...answer.failed] })),
      }),
    );
  }
}

const generated = { ...research, name: "New bot 2" };
const at = (minute: number) => `2026-11-07T00:0${minute}:00.000Z`;

/** A member chat at New bot 2 whose name row renames it; the rename's own list read starts as it answers. */
async function renameInChat(renamed: BotProfile) {
  setup();
  const registry = AtomRegistry.make();
  server.presentation = {
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { goatBotMembers: true, goatBotProfileEdit: true } },
    },
  };
  answerList(registry, { bots: [generated] });
  server.update = async () => {
    answerList(registry, { reading: [generated] });
    return { _tag: "Success", value: { bot: renamed } };
  };
  const chat = (): ReactNode => (
    <RegistryContext value={registry}>
      <NamedChat />
    </RegistryContext>
  );
  const screen = await render(chat(), { router: false }); // A hook check.
  const nameField = page.getByRole("textbox", { name: "Name this bot" });
  await userEvent.fill(nameField, renamed.name);
  await userEvent.keyboard("{Enter}");
  /** The list read answers; the chat renders again, as a settled query re-renders its readers. */
  const listAnswers = async (answer: ListAnswer) => {
    await act(() => answerList(registry, answer));
    await screen.rerender(chat());
  };
  return { screen, nameField, listAnswers };
}

it("a rename the list has not caught up with names the chat, and its name row goes away", async () => {
  const { screen, nameField, listAnswers } = await renameInChat({
    ...generated,
    name: "Scout",
    updatedAt: at(5),
  });
  await using _screen = screen;
  await expect.element(screen.getByRole("heading")).toHaveTextContent("Scout");
  expect(nameField.query()).toBeNull();
  // The read after the rename failed, so the last good list still says New bot 2.
  await listAnswers({ failed: [generated] });
  await expect.element(screen.getByRole("heading")).toHaveTextContent("Scout");
});

it("a rename answered at the list's own timestamp names the chat until the list is read again", async () => {
  // The server's clock gave the rename the same instant the listed profile has.
  const { screen, listAnswers } = await renameInChat({ ...generated, name: "Scout" });
  await using _screen = screen;
  await expect.element(screen.getByRole("heading")).toHaveTextContent("Scout");
  // Another device renamed the bot in that same instant; the list read after the rename says so.
  await listAnswers({ bots: [{ ...generated, name: "Atlas" }] });
  await expect.element(screen.getByRole("heading")).toHaveTextContent("Atlas");
});

it("a deletion the list reads after the rename shows, though the deleting server's clock is behind", async () => {
  const { screen, listAnswers } = await renameInChat({
    ...generated,
    name: "Scout",
    updatedAt: at(5),
  });
  await using _screen = screen;
  const heading = screen.getByRole("heading");
  await expect.element(heading).toHaveTextContent("Scout");
  await listAnswers({
    bots: [{ ...generated, name: "Scout", state: "deleted", updatedAt: at(4) }],
  });
  await expect.element(heading).toHaveAttribute("data-state", "deleted");
});
