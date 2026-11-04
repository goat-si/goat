import { createMemoryHistory } from "@tanstack/react-router";
import { ThreadId } from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { getRouter } from "~/router";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useGlobalAgentStore } from "~/globalAgentStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "./fakeEnvironment";
import { render } from "./render";

vi.mock("../../../packages/client-runtime/src/connection/driver.ts", async (original) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    original<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("./fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
vi.mock("~/components/goatBot/useGoatBotSession", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useGoatBotEnabled: () => ({
    enabled: true,
    environment: { environmentId: ENVIRONMENT_ID },
    environments: [],
    home: {},
    port: null,
  }),
  useGoatBotSession: () => ({
    availability: {
      kind: "ready",
      bot: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("bot") },
    },
    confirmedBot: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("bot") },
    canOperate: true,
    rows: fixtureTimeline,
    rowsForTask: () => [],
    supportsTaskThreads: true,
    attachmentSupport: null,
    onSend: () => true,
    onSendToTask: () => true,
    onRetryInput: () => {},
    onDiscardInput: () => {},
  }),
}));
vi.mock("~/components/goatBot/useGoatBotHome", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useGoatBotHome: () => {},
  useGoatBotHomeSettings: () => ({
    resolution: { state: "unknown" },
    moveTarget: null,
    busy: false,
    error: null,
  }),
}));
vi.mock("~/components/goatBot/useGoatBotWaitingCount", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useGoatBotWaitingCount: () => 3,
}));
vi.mock("~/components/goatBot/useBotRoster", () => ({
  useBotRoster: () => ({
    environmentId: ENVIRONMENT_ID,
    roster: fixtureProfiles
      ? [
          { kind: "main", profile: { name: "GOAT Bot" } },
          {
            kind: "member",
            profile: {
              botId: "helper",
              name: "Helper Bot",
              environmentId: ENVIRONMENT_ID,
              sessionThreadId: ThreadId.make("worker"),
            },
          },
        ]
      : [{ kind: "main", profile: null }],
    rows: fixtureEmpty ? [] : fixtureRows,
    refresh: () => {},
    slackEnabled: true,
  }),
}));
let fixtureEmpty = false;
let fixtureProfiles = false;
const fixtureTimeline = [
  {
    kind: "task",
    id: "timeline-task",
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    card: {
      key: "blocked",
      revision: 1,
      updatedAt: "2026-10-12T09:40:00Z",
      title: "Review a very long task title with more than forty characters",
      statusLabel: "Waiting",
      tone: "active",
      sourceLabel: null,
      summary: null,
      attentionLabel: null,
      pullRequests: [],
      target: { kind: "none", label: "Unavailable" },
    },
  },
];
const at = new Date().toISOString();
const fixtureRows = [
  "working",
  "blocked",
  "done",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
].map((id) => ({
  kind: "task",
  task: {
    taskId: id,
    title: `${id}: Review a very long task title with more than forty characters`,
    status:
      id === "blocked"
        ? "waiting_input"
        : !["working", "blocked"].includes(id)
          ? "completed"
          : "running",
    updatedAt: at,
  },
  view: {
    taskId: id,
    pinnedAt: null,
    doneAt: !["working", "blocked"].includes(id) ? at : null,
    readThrough: null,
  },
  lastActivityAt: at,
  unread: id === "blocked",
  mainMessagesSinceQuiet: 0,
}));
fixtureRows.push({
  kind: "coding",
  taskId: "blocked",
  environmentId: ENVIRONMENT_ID,
  threadId: ThreadId.make("worker"),
  title: "Coding child: Fix a long cross-platform implementation issue",
  state: "bound",
  lastActivityAt: at,
} as never);
installFakeEnvironment(
  [
    {
      ...threadWithHistory("bot", 2),
      shell: { lastVisitedAt: DateTime.makeUnsafe("2026-03-16T00:00:00.000Z") },
    },
    threadWithHistory("worker", 1),
  ],
  { capabilities: { goatBotTaskThreads: true } },
);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});
useGlobalAgentStore.setState({
  mode: "bot",
  botRef: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, threadId: ThreadId.make("bot") },
});

async function setup(entry = `/${ENVIRONMENT_ID}/bot`) {
  await page.viewport(820, 900);
  useGlobalAgentStore.setState({
    mode: "bot",
    botRef: {
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      threadId: ThreadId.make("bot"),
    },
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [entry] }));
  await router.load();
  return render(<AppRoot router={router} />, { router: false });
}

it("focuses the pane heading after Enter on a sidebar task", async () => {
  await using _screen = await setup();
  const row = page.getByRole("link", { name: /blocked: Review/ });
  await expect.element(row).toBeVisible();
  row.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("heading", { name: /blocked: Review/ })).toHaveFocus();
});

it("focuses the pane from a main-chat pill and returns focus to the pill", async () => {
  await using _screen = await setup();
  const pill = page.getByRole("link", { name: /Task thread · Review/ });
  await expect.element(pill).toBeVisible();
  pill.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("heading", { name: /blocked: Review/ })).toHaveFocus();
  await userEvent.click(page.getByRole("button", { name: "Back to Tasks" }));
  await expect.element(page.getByRole("link", { name: /Task thread · Review/ })).toHaveFocus();
});

it("returns focus to the main composer when the opener is removed", async () => {
  await using _screen = await setup();
  const pill = page.getByRole("link", { name: /Task thread · Review/ });
  await expect.element(pill).toBeVisible();
  pill.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("heading", { name: /blocked: Review/ })).toHaveFocus();
  const removed = fixtureTimeline.splice(0);
  try {
    await userEvent.click(page.getByRole("button", { name: "Back to Tasks" }));
    await expect.element(page.getByRole("textbox", { name: "Message GOAT Bot" })).toHaveFocus();
  } finally {
    fixtureTimeline.push(...removed);
  }
});

it("does not focus the heading on direct task navigation", async () => {
  await using _screen = await setup("/bot?task=blocked");
  const heading = page.getByRole("heading", { name: /blocked: Review/ });
  await expect.element(heading).toBeVisible();
  expect(document.activeElement).not.toBe(heading.element());
});

it.each([220, 256, 320])(
  "keeps the new bot badge inside the button at %ipx sidebar width",
  async (width) => {
    await using _screen = await setup();
    const button = page.getByRole("button", { name: /New bot/ });
    await expect.element(button).toBeVisible();
    const el = button.element();
    const group = el.closest('[data-sidebar="group"]');
    if (!(group instanceof HTMLElement)) throw new Error("Sidebar group missing");
    group.style.width = `${width}px`;
    const badge = Array.from(el.querySelectorAll("span")).find(
      (span) => span.textContent === "Coming soon",
    );
    if (!badge) throw new Error("Badge missing");
    const outer = el.getBoundingClientRect();
    const inner = badge.getBoundingClientRect();
    expect(inner.left).toBeGreaterThanOrEqual(outer.left);
    expect(inner.right).toBeLessThanOrEqual(outer.right);
    expect(inner.top).toBeGreaterThanOrEqual(outer.top);
    expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
  },
);
