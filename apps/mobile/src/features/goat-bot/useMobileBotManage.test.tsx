import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotProfile } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const rn = vi.hoisted(() => ({ alert: vi.fn() }));
const rpc = vi.hoisted(() => ({ result: { _tag: "Success" } as object, inputs: [] as unknown[] }));
// Whether the bot's computer is connected, as the app's environment presentation says.
const link = vi.hoisted(() => ({ phase: "connected" }));
vi.mock("react-native", () => ({ Alert: { alert: rn.alert } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./goatBotComputerLink", () => ({
  useGoatBotComputerConnected: () => link.phase === "connected",
  goatBotComputerConnectedNow: () => link.phase === "connected",
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    createBot: { permissionAtom: () => "can-create" },
    setBotHidden: { permissionAtom: () => "can-manage" },
    updateBot: { permissionAtom: () => "can-edit" },
    restoreBot: {},
  },
}));
// The RPC boundary: what the server answered to restoreBot.
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, _command: unknown, args: { input: unknown }) => {
    rpc.inputs.push(args.input);
    return rpc.result;
  },
}));

import { useMobileBotManage } from "./useMobileBotManage";

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "thread-scout",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  state: "deleted",
});

async function restoreScout() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  link.phase = "connected";
  let manage: ReturnType<typeof useMobileBotManage> | null = null;
  function Probe() {
    manage = useMobileBotManage(scout.environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const restored = await manage!.restore(scout);
  await act(async () => root.unmount());
  return restored;
}

it("a failed restore tells the person why in an alert and reports that it did not work", async () => {
  rn.alert.mockClear();
  rpc.result = { _tag: "Failure", cause: Cause.fail(new Error("GOAT Bot's computer is offline.")) };
  expect(await restoreScout()).toBe(false);
  expect(rn.alert).toHaveBeenCalledExactlyOnceWith(
    "Couldn't restore Scout",
    "GOAT Bot's computer is offline.",
  );
});

it("a successful restore shows no alert", async () => {
  rn.alert.mockClear();
  rpc.result = { _tag: "Success", value: { bot: scout } };
  expect(await restoreScout()).toBe(true);
  expect(rn.alert).not.toHaveBeenCalled();
});

it("sends a new bot's colour when one was chosen, and no colour key otherwise", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let manage: ReturnType<typeof useMobileBotManage> | null = null;
  function Probe() {
    manage = useMobileBotManage(scout.environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  rpc.result = { _tag: "Success", value: { bot: scout } };
  rpc.inputs.length = 0;
  await manage!.create({ name: "Scout", avatar: null, purpose: "", color: "#0F766E" }, null, "r1");
  await manage!.create({ name: "Scout", avatar: null, purpose: "" }, null, "r2");
  expect(rpc.inputs).toEqual([
    {
      clientRequestId: "r1",
      name: "Scout",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
      color: "#0F766E",
    },
    {
      clientRequestId: "r2",
      name: "Scout",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    },
  ]);
  await act(async () => root.unmount());
});

function setupOffline() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rn.alert.mockClear();
  rpc.inputs.length = 0;
  rpc.result = { _tag: "Success", value: { bot: scout } };
  link.phase = "connected";
}

it("offers no bot writes while the bot's computer is offline, and offers them again once it is back", async () => {
  setupOffline();
  let manage: ReturnType<typeof useMobileBotManage> | null = null;
  function Probe() {
    manage = useMobileBotManage(scout.environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  link.phase = "disconnected";
  await act(async () => root.render(<Probe />));
  expect(manage!.canCreate).toBe(false);
  expect(manage!.canEdit).toBe(false);
  expect(manage!.canManage).toBe(false);
  link.phase = "connected";
  await act(async () => root.render(<Probe />));
  expect(manage!.canCreate).toBe(true);
  expect(manage!.canEdit).toBe(true);
  expect(manage!.canManage).toBe(true);
  await act(async () => root.unmount());
});

it("a write started from a menu opened before the computer went offline sends nothing", async () => {
  setupOffline();
  let manage: ReturnType<typeof useMobileBotManage> | null = null;
  function Probe() {
    manage = useMobileBotManage(scout.environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  // The menu kept the actions it was opened with; the computer drops before the person picks one.
  const opened = manage!;
  link.phase = "disconnected";
  expect(await opened.restore(scout)).toBe(false);
  expect(await opened.hide(scout, true)).toBe(false);
  // A profile save (the bot sheet, and Settings > GOAT Bot) says why it did not go out.
  expect(await opened.update(scout, { name: "Scout 2" })).toBe(
    "GOAT Bot's computer isn't connected.",
  );
  expect(rpc.inputs).toEqual([]);
  link.phase = "connected";
  expect(await opened.restore(scout)).toBe(true);
  expect(rpc.inputs).toHaveLength(1);
  await act(async () => root.unmount());
});
