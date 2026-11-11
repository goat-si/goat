import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { GoatBotNeedsYouRow } from "./goatBotNeedsYou";

const needs = vi.hoisted(() => ({
  value: { total: 0, rows: [] as GoatBotNeedsYouRow[] },
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
vi.mock("./useMobileBotsNeedingYou", () => ({ useMobileBotsNeedingYou: () => needs.value }));

import { MobileNeedsYouStrip } from "./MobileNeedsYouStrip";

const scout: BotRosterEntry = {
  kind: "member",
  profile: { botId: "scout" } as unknown as BotProfile,
};
const main: BotRosterEntry = { kind: "main", profile: null };

async function show(onOpenBot = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<MobileNeedsYouStrip bots={[main, scout]} onOpenBot={onOpenBot} />),
  );
  return { container, onOpenBot, unmount: () => act(async () => root.unmount()) };
}

it("stays away while nothing waits on the person", async () => {
  needs.value = { total: 0, rows: [] };
  const view = await show();
  expect(view.container.textContent).toBe("");
  await view.unmount();
});

it("says how much waits and the newest ask in one line, opens in place, and a row opens that chat", async () => {
  needs.value = {
    total: 3,
    rows: [
      {
        entry: scout,
        name: "Scout",
        count: 2,
        ask: { text: "Approve the deploy?", at: "2026-11-11T10:05:00Z" },
      },
      { entry: main, name: "GOAT Bot", count: 1, ask: null },
    ],
  };
  const view = await show();
  const strip = view.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(strip?.getAttribute("aria-label")).toBe("3 waiting for you. Scout: Approve the deploy?");
  expect(strip?.getAttribute("aria-expanded")).toBe("false");
  expect(view.container.querySelectorAll("button")).toHaveLength(1);
  await act(async () => strip?.click());
  expect(strip?.getAttribute("aria-expanded")).toBe("true");
  const row = view.container.querySelector<HTMLButtonElement>('[aria-label="GOAT Bot, 1 waiting"]');
  await act(async () => row?.click());
  expect(view.onOpenBot).toHaveBeenCalledWith(main);
  await view.unmount();
});
