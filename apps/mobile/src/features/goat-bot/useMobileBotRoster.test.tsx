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
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    environments: [
      { environmentId: "env", connected: state.connected, supportsChannelLedger: true },
    ],
    botRef: state.botRef,
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      ["env", { serverConfig: { environment: { capabilities: state.capabilities } } }],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    if (query) state.calls.push(query);
    return {
      data: query === "threads" ? { rows: [] } : query === "profiles" ? { bots: state.bots } : null,
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
