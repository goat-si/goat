import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// The server's open asks read, the machine's capabilities, and whether the app is in front.
const server = vi.hoisted(() => ({
  openAsks: true,
  connected: true,
  data: null as null | { asks: object[]; total: number; truncated: boolean },
  error: null as string | null,
  refresh: vi.fn(),
  active: true,
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./GoatBotMessageParts", () => ({ goatBotTime: (iso: string) => iso.slice(11, 16) }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "bot" } }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  createEnvironmentRpcQueryAtomFamily: () => () => "open-asks",
}));
vi.mock("../../lib/appState", () => ({ useAppActive: () => server.active }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: server.connected ? "connected" : "disconnected" },
          serverConfig: { environment: { capabilities: { goatBotOpenAsks: server.openAsks } } },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data: atom === null ? null : server.data,
    error: atom === null ? null : server.error,
    refresh: server.refresh,
  }),
}));

import { MobileNeedsYouStrip } from "./MobileNeedsYouStrip";

const scout: BotRosterEntry = {
  kind: "member",
  profile: { botId: "scout", name: "Scout" } as unknown as BotProfile,
};
const main: BotRosterEntry = { kind: "main", profile: null };
const ask = (botId: string, text: string, askedAt: string, taskId = `task-${botId}`) => ({
  botId,
  taskId,
  kind: "question",
  text,
  askedAt,
});

function reset() {
  Object.assign(server, { openAsks: true, connected: true, data: null, error: null, active: true });
  server.refresh.mockClear();
}
async function show(onOpenBot = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(async () =>
      root.render(<MobileNeedsYouStrip bots={[main, scout]} onOpenBot={onOpenBot} />),
    );
  await render();
  return { container, onOpenBot, render, unmount: () => act(async () => root.unmount()) };
}
const strip = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[aria-expanded]");

it("says how much waits and the newest ask with its bot and time, opens in place, and an ask opens its chat", async () => {
  reset();
  server.data = {
    asks: [
      ask("scout", "Approve the deploy?", "2026-11-11T10:05:00Z"),
      ask("main-bot", "Which project should I use?", "2026-11-11T09:40:00Z"),
    ],
    total: 2,
    truncated: false,
  };
  const view = await show();
  expect(strip(view.container)?.getAttribute("aria-label")).toBe(
    "2 waiting for you. Scout: Approve the deploy?",
  );
  expect(view.container.textContent).toContain("10:05");
  expect(view.container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => strip(view.container)?.click());
  const rows = [...view.container.querySelectorAll("button")].slice(1);
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "Scout, 10:05: Approve the deploy?",
    // An ask from a bot the roster has no profile for is the main bot's.
    "GOAT Bot, 09:40: Which project should I use?",
  ]);
  await act(async () => rows[1]?.click());
  expect(view.onOpenBot).toHaveBeenCalledWith(main);
  await act(async () => rows[0]?.click());
  expect(view.onOpenBot).toHaveBeenLastCalledWith(scout);
  await view.unmount();
});

it("keeps an ask after the person visits its chat without answering, and drops it once answered", async () => {
  reset();
  server.data = {
    asks: [ask("scout", "Approve the deploy?", "2026-11-11T10:05:00Z")],
    total: 1,
    truncated: false,
  };
  const view = await show();
  // Visiting the chat changes no open ask on the server; the roster reads again on return.
  server.active = false;
  await view.render();
  server.active = true;
  await view.render();
  expect(server.refresh).toHaveBeenCalled();
  expect(strip(view.container)?.getAttribute("aria-label")).toBe(
    "1 waiting for you. Scout: Approve the deploy?",
  );
  server.data = { asks: [], total: 0, truncated: false };
  await view.render();
  expect(view.container.textContent).toBe("");
  await view.unmount();
});

it("says a failed read failed, and marks a partial count as at least", async () => {
  reset();
  server.error = "offline";
  const view = await show();
  const retry = view.container.querySelector<HTMLButtonElement>(
    '[aria-label="Couldn\'t check what waits for you. Try again"]',
  );
  expect(retry).not.toBeNull();
  server.refresh.mockClear();
  await act(async () => retry?.click());
  expect(server.refresh).toHaveBeenCalledTimes(1);
  server.error = null;
  server.data = {
    asks: [ask("scout", "Approve the deploy?", "2026-11-11T10:05:00Z")],
    total: 200,
    truncated: true,
  };
  await view.render();
  expect(strip(view.container)?.getAttribute("aria-label")).toBe(
    "200+ waiting for you. Scout: Approve the deploy?",
  );
  await view.unmount();
});

it("shows nothing on a server without open asks, or while the bots' machine is offline", async () => {
  reset();
  server.data = {
    asks: [ask("scout", "Approve?", "2026-11-11T10:05:00Z")],
    total: 1,
    truncated: false,
  };
  server.openAsks = false;
  const view = await show();
  expect(view.container.textContent).toBe("");
  server.openAsks = true;
  server.connected = false;
  await view.render();
  expect(view.container.textContent).toBe("");
  await view.unmount();
});
