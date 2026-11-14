import { BotId, EnvironmentId } from "@goat/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  governed: {} as Record<string, boolean>,
  unread: {} as Record<string, number | "pending" | "unavailable">,
  reads: [] as string[],
}));
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));
vi.mock("@goat/client-runtime/goatBot", () => ({
  homeWorkGoverns: (value: { governs: boolean }) => value.governs,
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    homeCurrentUnreadAtom: ([id, bot]: [string, string]) => `unread:${id}:${bot}`,
  },
}));
vi.mock("../../state/goatBotHomeWork", () => ({
  mobileGoatBotHomeWorkByEnvironment: (id: string) => `by-env:${id}`,
}));
vi.mock("effect/reactivity", () => ({
  Atom: {
    make: (value: unknown) => {
      const atom = { value, pipe: () => atom };
      return atom;
    },
    family: (make: (key: string) => unknown) => (key: string) => ({ governedFor: key, make }),
    withLabel: () => (atom: unknown) => atom,
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { governedFor?: string; value?: unknown } | string) => {
    if (typeof atom === "string") {
      state.reads.push(atom);
      return state.unread[atom] ?? "pending";
    }
    if (atom.governedFor !== undefined) return state.governed[atom.governedFor] === true;
    return atom.value;
  },
}));

import { useMobileBotRowSignals, type MobileBotRowSignals } from "./useMobileBotRowSignals";

const seen = { current: undefined as MobileBotRowSignals | null | undefined };
function Probe(props: Parameters<typeof useMobileBotRowSignals>[0]) {
  const value = useMobileBotRowSignals(props);
  useEffect(() => {
    seen.current = value;
  });
  return null;
}
const container = document.createElement("div");
async function show(props: Parameters<typeof useMobileBotRowSignals>[0]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  await act(async () => root.render(<Probe {...props} />));
  await act(async () => root.unmount());
  return seen.current;
}
function setup(governed: boolean, unread: Record<string, number | "pending" | "unavailable"> = {}) {
  state.governed = { env: governed };
  state.unread = unread;
  state.reads = [];
  seen.current = undefined;
}
const env = EnvironmentId.make("env");
const scout = BotId.make("scout");

it("where Home does not govern the computer, a row has no signals and reads none of the bot's work", async () => {
  setup(false);
  expect(await show({ environmentId: env, botId: scout, waiting: "unavailable" })).toBeNull();
  expect(state.reads).toEqual([]);
});

// The count itself is derived from the bot's list in the shared atom; goatBotHomeThreadHiding.test.tsx
// runs it from real task rows to the rendered row.
it("where Home governs, a count it is given reads as unread recent work only", async () => {
  setup(true, { "unread:env:scout": 2 });
  const signals = await show({ environmentId: env, botId: scout, waiting: "ready" });
  expect(signals?.unread).toBe(2);
  expect(signals?.missing).toBeNull();
  expect(signals?.spoken).toEqual(["2 unread tasks; recent work only; older work may be missing"]);
});

it("names each count it cannot read, and says nothing while the bot's list is still loading", async () => {
  setup(true, { "unread:env:scout": "unavailable" });
  expect(
    (await show({ environmentId: env, botId: scout, waiting: "unavailable" }))?.spoken,
  ).toEqual(["Unread and waiting unavailable"]);
  state.unread = { "unread:env:scout": "pending" };
  const loading = await show({ environmentId: env, botId: scout, waiting: "pending" });
  expect(loading?.unread).toBeNull();
  expect(loading?.spoken).toEqual([]);
});
