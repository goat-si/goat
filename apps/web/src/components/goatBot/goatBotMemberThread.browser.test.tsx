import { BotProfile, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const server = vi.hoisted(() => ({
  presentation: null as null | object,
  query: { data: null, error: null, isPending: false } as {
    data: null | { bots: unknown[] };
    error: string | null;
    isPending: boolean;
  },
  listed: [] as unknown[],
}));
vi.mock("~/state/environments", () => ({ useEnvironment: () => server.presentation }));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBots: (args: { readonly input: unknown }) => {
      server.listed.push(args.input);
      return {};
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === null
      ? { data: null, error: null, isPending: false, refresh: () => {} }
      : { ...server.query, refresh: () => {} },
}));

import { useGoatBotMemberAt } from "./goatBotMemberThread";

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

it("names the main chat from a server that keeps profiles but not members", async () => {
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
  server.listed = [];
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
