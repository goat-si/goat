import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";

const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, boolean>,
  calls: [] as string[],
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    environments: [{ environmentId: "env", connected: true, supportsChannelLedger: true }],
    botRef: null,
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
      data: query === "threads" ? { rows: [] } : query === "profiles" ? { bots: [] } : null,
      error: null,
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
import { useMobileBotRoster } from "./useMobileBotRoster";

let value: ReturnType<typeof useMobileBotRoster>;
function Probe() {
  value = useMobileBotRoster(null);
  return null;
}
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  state.calls = [];
  state.capabilities = {};
});

it("queries only capabilities advertised by the selected bot environment", async () => {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
  expect(value.environmentId).toBe(EnvironmentId.make("env"));
  expect(value.bots).toEqual([{ kind: "main", profile: null }]);
  expect(state.calls).toEqual([]);
  state.capabilities = { goatBotProfiles: true, goatBotTaskThreads: true };
  await act(async () => root?.render(<Probe />));
  expect(state.calls).toEqual(["profiles", "threads"]);
});
