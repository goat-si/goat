import { botRosterGroups } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

// The member row with its real status read: only the server's answer and capabilities are fake.
const server = vi.hoisted(() => ({
  connected: true,
  status: true,
  waitingRead: true,
  memberEligible: true,
  answer: "success" as "success" | "pending" | "failure",
  version: 0,
  listeners: new Set<() => void>(),
}));
const publish = () => {
  server.version++;
  for (const listener of server.listeners) listener();
};
const useTick = () =>
  useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => {
        server.listeners.delete(listener);
      };
    },
    () => server.version,
  );

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
  Link: ({
    children,
    params: _params,
    to,
    ...props
  }: ComponentProps<"a"> & { params?: object; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => {
    useTick();
    // Home governs an environment only while it is connected and every bot on it is eligible.
    if (atom === "governed") return server.connected && server.memberEligible;
    if (atom === "unread-count") return 0;
    if (atom === "current-work")
      return { eligible: true, list: "ready", work: { running: [], waiting: [], finished: [] } };
    return true;
  },
}));
vi.mock("./goatBotGoverned", () => ({ goatBotGovernedAtom: () => "governed" }));
vi.mock("~/state/channels", () => {
  const command = (tag: string) => ({ tag, permissionAtom: () => null });
  return {
    channelEnvironment: {
      botStatus: () => "status",
      homeCurrentOpenableWorkAtom: () => "current-work",
      homeCurrentUnreadAtom: () => "unread-count",
      setBotHidden: command("hide"),
      deleteBot: command("delete"),
      restoreBot: command("restore"),
      updateBot: command("update"),
    },
  };
});
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    useTick();
    if (query === null)
      return { data: undefined, isSuccess: false, error: null, refresh: () => {} };
    return {
      data: server.answer === "success" ? { waitingCount: 3 } : undefined,
      isSuccess: server.answer === "success",
      error: server.answer === "failure" ? "failed" : null,
      refresh: () => {},
    };
  },
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => {
    useTick();
    return {
      connection: { phase: server.connected ? "connected" : "disconnected" },
      serverConfig: {
        environment: {
          capabilities: {
            goatBotTaskThreadsPaged: true,
            goatBotTaskLookupSearch: true,
            goatBotMembers: true,
            goatBotProfiles: true,
            goatBotStatus: server.status,
            goatBotWaitingRead: server.waitingRead,
          },
        },
      },
    };
  },
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./GoatBotModeButton", () => ({ useGoatBotPreferred: () => false }));
vi.mock("./useGoatBotWaitingCount", () => ({ useGoatBotWaitingCount: () => 0 }));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: link, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(link, {}, children),
}));

import { GoatBotMemberRoster } from "./GoatBotMemberRows";

const environmentId = EnvironmentId.make("env-1");
const research = Schema.decodeSync(BotProfile)({
  botId: "research",
  role: "member",
  name: "Research",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId,
  sessionThreadId: "thread-research",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});
const roster = () => (
  <GoatBotMemberRoster environmentId={environmentId} groups={botRosterGroups([research])} />
);
function setup() {
  server.connected = true;
  server.status = true;
  server.waitingRead = true;
  server.memberEligible = true;
  server.answer = "success";
}
const change = (edit: () => void) => act(() => (edit(), publish()));

it("a governed member row counts only a successful visit-aware read, and marks the rest unavailable", async () => {
  setup();
  await using screen = await render(roster(), { router: false });
  await expect
    .element(screen.getByRole("link", { name: /^3 waiting for you\s*Research/ }))
    .toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  await change(() => (server.answer = "pending"));
  await expect.element(screen.getByRole("link", { name: /^Research/ })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
  await change(() => (server.answer = "failure"));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: /^Research/ })).toBeVisible();
  await change(() => ((server.answer = "success"), (server.waitingRead = false)));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
  await change(() => ((server.waitingRead = true), (server.status = false)));
  await expect.element(screen.getByLabelText("waiting unavailable")).toBeVisible();
});

it("an offline member row is the older row: no count read, no mark", async () => {
  setup();
  await using screen = await render(roster(), { router: false });
  await expect
    .element(screen.getByRole("link", { name: /^3 waiting for you\s*Research/ }))
    .toBeVisible();
  await change(() => (server.connected = false));
  await expect.element(screen.getByRole("link", { name: /^Research/ })).toBeVisible();
  expect(screen.getByLabelText(/unavailable/i).query()).toBeNull();
});
