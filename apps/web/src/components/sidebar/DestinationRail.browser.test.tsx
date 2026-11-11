import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "~/index.css";

const bots = vi.hoisted(() => ({
  roster: [] as Array<object>,
  mainWaiting: 0,
  latest: {} as Record<string, { text: string; at: string; author: "bot" | "person" }>,
  waiting: {} as Record<string, number>,
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params: _params,
    activeOptions: _activeOptions,
    ...props
  }: ComponentProps<"a"> & { to: string; params?: object; activeOptions?: object }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => cloneElement(render),
  TooltipPopup: () => null,
}));
vi.mock("../goatBot/useBotRoster", () => ({ useBotRoster: () => ({ roster: bots.roster }) }));
vi.mock("../goatBot/useGoatBotWaitingCount", () => ({
  useGoatBotWaitingCount: () => bots.mainWaiting,
}));
vi.mock("../goatBot/useGoatBotReadMenu", () => ({ useGoatBotReadMenu: () => ({}) }));
vi.mock("../goatBot/GoatBotModeButton", () => ({ useGoatBotPreferred: () => false }));
vi.mock("../goatBot/useGoatBotMemberStatus", () => ({
  useGoatBotMemberStatus: (bot: BotProfile) => ({
    waitingCount: bots.waiting[bot.botId] ?? 0,
    latest: bots.latest[bot.botId],
  }),
  useGoatBotMemberWaitingCount: (bot: BotProfile) => bots.waiting[bot.botId] ?? 0,
}));
// The rail reads each bot's status alone: no conversation shell or items are loaded here.
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));

import { BotRailItem } from "./DestinationRail";

const decodeProfile = Schema.decodeSync(BotProfile);
const environmentId = EnvironmentId.make("env-1");
const profile = (botId: string, name: string, role: "main" | "member" = "member") =>
  decodeProfile({
    botId,
    role,
    name,
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId,
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });

function setup() {
  bots.roster = [
    { kind: "main", profile: profile("main", "Helper", "main") },
    { kind: "member", profile: profile("scout", "Scout") },
    { kind: "member", profile: profile("quiet", "Quiet") },
  ];
  bots.mainWaiting = 0;
  bots.latest = {};
  bots.waiting = {};
}

it("a rail link names its bot's state first and an idle bot by name alone", async () => {
  setup();
  using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T01:00:30.000Z"));
  bots.latest = {
    scout: { text: "is main green?", at: "2026-11-07T01:00:00.000Z", author: "person" },
  };
  await using screen = await render(<BotRailItem active={false} />, { router: false });
  await expect.element(screen.getByRole("link", { name: "Reading, Scout" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Quiet", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Helper", exact: true })).toBeVisible();
});

it("the main rail link says waiting once, with the count", async () => {
  setup();
  bots.mainWaiting = 2;
  bots.waiting = { quiet: 1 };
  await using screen = await render(<BotRailItem active={false} />, { router: false });
  await expect
    .element(screen.getByRole("link", { name: "2 waiting for you, Helper", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "1 waiting for you, Quiet", exact: true }))
    .toBeVisible();
});
