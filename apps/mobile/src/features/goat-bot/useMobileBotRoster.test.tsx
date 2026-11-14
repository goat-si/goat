import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";

const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, boolean>,
  calls: [] as string[],
  bots: [] as ReadonlyArray<Record<string, unknown>>,
  connected: true,
  botRef: null as { readonly environmentId: string; readonly threadId: string } | null,
  environmentId: "env",
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    environments: [
      {
        environmentId: state.environmentId,
        connected: state.connected,
        supportsChannelLedger: true,
      },
    ],
    botRef: state.botRef,
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        state.environmentId,
        { serverConfig: { environment: { capabilities: state.capabilities } } },
      ],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    if (query) state.calls.push(query);
    // An offline computer answers nothing; a read in flight or failed then has no data.
    const profiles = query === "profiles" && state.connected ? { bots: state.bots } : null;
    return {
      data: query === "threads" ? { rows: [] } : profiles,
      successResult: profiles === null ? null : { value: profiles },
      cause: null,
      error: null,
      isPending: false,
      isSuccess: query !== null,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBots: () => "profiles",
    listBotThreads: () => "threads",
    slackSettings: () => "slack",
    updateTaskView: {},
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
import { useMobileBotRoster, useMobileGoatBotMember } from "./useMobileBotRoster";
import { resetKeptPerComputerForTests } from "./useKeptPerComputer";

let value: ReturnType<typeof useMobileBotRoster>;
function Probe() {
  value = useMobileBotRoster();
  return null;
}
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  state.calls = [];
  state.capabilities = {};
  state.bots = [];
  state.connected = true;
  state.botRef = null;
  state.environmentId = "env";
  resetKeptPerComputerForTests();
});

it("queries only capabilities advertised by the selected bot environment, and never the bot's tasks", async () => {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
  expect(value.environmentId).toBe(EnvironmentId.make("env"));
  expect(value.bots).toEqual([{ kind: "main", profile: null }]);
  expect(state.calls).toEqual([]);
  state.capabilities = { goatBotProfiles: true, goatBotTaskThreads: true };
  await act(async () => root?.render(<Probe />));
  // The list holds bots only; each bot's tasks are read by its own home sheet.
  expect(state.calls).toEqual(["profiles"]);
});

it("names the main bot's chat with its renamed profile", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = [
    { botId: "main", role: "main", name: "Goaty", createdAt: "2026-11-01T00:00:00.000Z" },
    { botId: "echo", role: "member", name: "Echo", createdAt: "2026-11-02T00:00:00.000Z" },
  ];
  let named: ReturnType<typeof useMobileGoatBotMember> | undefined;
  function NameProbe(props: { readonly botId?: string }) {
    named = useMobileGoatBotMember(props.botId);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(named?.member).toBeNull();
  expect(named?.main?.name).toBe("Goaty");
  await act(async () => root?.render(<NameProbe botId="echo" />));
  expect(named?.member?.name).toBe("Echo");
});

it("reads the main bot's name only while its computer is connected, as the roster does", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.connected = false;
  // A saved home keeps its computer selected while it is offline.
  state.botRef = { environmentId: "env", threadId: "bot" };
  function NameProbe(props: { readonly botId?: string }) {
    useMobileGoatBotMember(props.botId);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(state.calls).toEqual([]);
  // A named member is still looked up, as before.
  await act(async () => root?.render(<NameProbe botId="echo" />));
  expect(state.calls).toContain("profiles");
});

const echoBots = [
  { botId: "main", role: "main", name: "GOAT Bot", createdAt: "2026-11-01T00:00:00.000Z" },
  { botId: "echo", role: "member", name: "Echo", createdAt: "2026-11-02T00:00:00.000Z" },
];
const memberNames = () =>
  value.bots.flatMap((entry) => (entry.kind === "member" ? [entry.profile.name] : []));

it("keeps the bots listed while their computer is offline, and still knows it has members", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  // A saved bot keeps its computer selected while that computer is offline.
  state.botRef = { environmentId: "env", threadId: "bot" };
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  state.connected = false;
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  expect(value.supportsMembers).toBe(true);
  expect(value.refreshBots).toBeNull();
});

it("a member chat opened for the first time while offline finds its bot in the list read before", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  await act(async () => root?.unmount());
  state.connected = false;
  state.botRef = { environmentId: "env", threadId: "bot" };
  let named: ReturnType<typeof useMobileGoatBotMember> | undefined;
  function NameProbe() {
    named = useMobileGoatBotMember("echo");
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<NameProbe />));
  expect(named?.member?.name).toBe("Echo");
  expect(named?.missing).toBe(false);
});

it("never shows one computer's kept bots for another", async () => {
  state.capabilities = { goatBotProfiles: true, goatBotMembers: true };
  state.bots = echoBots;
  state.environmentId = "first";
  state.botRef = { environmentId: "first", threadId: "bot" };
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
  state.connected = false;
  state.environmentId = "second";
  state.botRef = { environmentId: "second", threadId: "bot" };
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual([]);
  state.environmentId = "first";
  state.botRef = { environmentId: "first", threadId: "bot" };
  await act(async () => root?.render(<Probe />));
  expect(memberNames()).toEqual(["Echo"]);
});
