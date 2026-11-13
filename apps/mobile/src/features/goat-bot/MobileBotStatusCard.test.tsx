import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  BotThreadRow,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");
const state = vi.hoisted(() => ({
  homeConnected: false,
  moveTarget: null as null | { environmentId: string; label: string },
  changeHome: vi.fn(),
  memberUpdatedAt: "2026-11-07T10:00:00Z",
  homeConfig: null as unknown,
  refreshRows: vi.fn(),
  openChat: vi.fn(),
  presentations: new Map<string, unknown>(),
  slackQuery: { data: null as unknown, error: null as string | null, refresh: () => {} },
  homeError: null as string | null,
}));

vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({
    resolution: {
      state: "claimed",
      claim: { environmentId: "env-studio", claimedAt: 1, claimId: "claim" },
      homeKnown: true,
      homeConnected: state.homeConnected,
      homeSupportsBot: true,
      staleTargetIds: [],
    },
    environments: [
      { environmentId: "env-studio", label: "Mac Studio" },
      { environmentId: "env-laptop", label: "MacBook" },
    ],
    moveTarget: state.moveTarget,
    changeHome: state.changeHome,
    busy: false,
    error: state.homeError,
  }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: unknown) => (ref === null ? null : { updatedAt: state.memberUpdatedAt }),
  useEnvironmentServerConfig: (environmentId: string | null) =>
    environmentId === "env-studio" ? state.homeConfig : null,
}));
const homeConfig = {
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    goatBotModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  },
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
  ],
};
state.homeConfig = homeConfig;
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: state.presentations }),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: { slackSettings: () => "slack", slackStatus: () => "slack-status" },
}));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return { useAtomValue: () => AsyncResult.initial() };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "slack" ? state.slackQuery : { data: null, error: null, refresh: () => {} },
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-07T12:00:00Z") }));

import { MobileBotStatusCard } from "./MobileBotStatusCard";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

const waiting = Schema.decodeUnknownSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "ask", title: "Ask", status: "waiting_input", updatedAt: "2026-11-07T10:00:00Z" },
  view: { taskId: "ask", doneAt: null, pinnedAt: null, readThrough: null },
  lastActivityAt: "2026-11-07T10:00:00Z",
  unread: true,
  mainMessagesSinceQuiet: 0,
});

async function render(props: Partial<React.ComponentProps<typeof MobileBotStatusCard>> = {}) {
  root ??= createRoot(container);
  const onOpenTask = vi.fn();
  await act(async () =>
    root?.render(
      <MobileBotStatusCard
        environmentId={STUDIO}
        member={null}
        rows={[]}
        refreshRows={state.refreshRows}
        turnsWaiting={[]}
        onOpenChat={state.openChat}
        onOpenTask={onOpenTask}
        {...props}
      />,
    ),
  );
  return onOpenTask;
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);

it("says the home machine is offline and moves the bot where the viewer may write", async () => {
  state.homeConnected = false;
  state.moveTarget = { environmentId: LAPTOP, label: "MacBook" };
  await render({ rows: "unavailable" });
  expect(container.textContent).toContain("Not working");
  expect(container.textContent).toContain("Home machine is offline (Mac Studio)");
  await act(async () => button("Make MacBook the home")?.click());
  expect(state.changeHome).toHaveBeenCalledWith(LAPTOP);

  state.moveTarget = null;
  await render({ rows: "unavailable" });
  expect(button("Make MacBook the home")).toBeUndefined();
});

it("judges a member by its own model and opens the task that waits for an answer", async () => {
  state.homeConnected = true;
  const onOpenTask = await render({
    member: {
      threadId: ThreadId.make("member-thread"),
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-9" },
    },
    rows: [waiting],
  });
  expect(container.textContent).toContain("Answers on Mac Studio");
  expect(container.textContent).toContain("Model unavailable: gpt-9");
  expect(container.textContent).toContain("1 waiting for your answer");
  expect(button("Choose another model")).toBeUndefined();
  await act(async () => button("Answer")?.click());
  expect(onOpenTask).toHaveBeenCalledWith("ask");
});

it("reads a member's tasks again when its conversation changes", async () => {
  state.homeConnected = true;
  state.refreshRows.mockClear();
  const member = { threadId: ThreadId.make("member-thread"), defaultModelSelection: null };
  await render({ member });
  const before = state.refreshRows.mock.calls.length;
  await render({ member });
  expect(state.refreshRows.mock.calls.length).toBe(before);
  state.memberUpdatedAt = "2026-11-07T11:00:00Z";
  await render({ member });
  expect(state.refreshRows.mock.calls.length).toBe(before + 1);
});

it("reads the named home even when the sheet shows another machine", async () => {
  state.homeConnected = true;
  await render({ environmentId: LAPTOP, rows: [waiting] });
  expect(container.textContent).toContain("Answers on Mac Studio");
  expect(container.textContent).toContain("GPT-5.4 on Codex");
  expect(container.textContent).not.toContain("waiting for your answer");
  expect(button("Answer")).toBeUndefined();
});

it("says it couldn't check Slack when a re-read fails after an earlier success", async () => {
  state.homeConnected = true;
  state.presentations = new Map([
    [
      "env-studio",
      {
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { slackChannel: true } } },
      },
    ],
  ]);
  const connected = [{ connectionId: "slack-1", enabled: true, status: "connected" }];
  state.slackQuery = { data: connected, error: null, refresh: () => {} };
  await render();
  expect(container.textContent).toContain("Slack connected");
  state.slackQuery = { data: connected, error: "socket closed", refresh: () => {} };
  await render();
  expect(container.textContent).toContain("Couldn't check Slack");
  expect(container.textContent).not.toContain("Ready");
  state.presentations = new Map();
  state.slackQuery = { data: null, error: null, refresh: () => {} };
});

it("says Ready for a healthy main bot once its work has loaded", async () => {
  state.homeConnected = true;
  await render({ rows: null });
  expect(container.textContent).toContain("Loading work…");
  expect(container.textContent).not.toContain("Ready");
  await render({ rows: [] });
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain("GPT-5.4 on Codex");
});

it("on Home, says nothing for a ready bot and still shows a bot that needs attention", async () => {
  state.homeConnected = true;
  await render({ rows: [], quietWhenReady: true });
  expect(container.textContent).toBe("");
  await render({ rows: [], turnsWaiting: ["turn-1"], quietWhenReady: true });
  expect(container.textContent).toContain("Needs attention");
  expect(container.textContent).toContain("1 waiting for your answer");
});

it("on Home, keeps a failed home change in view even when the new home is ready", async () => {
  state.homeConnected = true;
  state.homeError = "Moved, but MacBook could not be told.";
  try {
    await render({ rows: [], quietWhenReady: true });
    expect(container.textContent).toContain("Moved, but MacBook could not be told.");
  } finally {
    state.homeError = null;
  }
});

it("says the bot waits for an answer in the chat when its own turn asked a question", async () => {
  state.homeConnected = true;
  state.openChat.mockClear();
  await render({ rows: [], turnsWaiting: ["turn-1"] });
  expect(container.textContent).toContain("Needs attention");
  expect(container.textContent).toContain("1 waiting for your answer");
  expect(container.textContent).not.toContain("Ready");
  await act(async () => button("Open the chat")?.click());
  expect(state.openChat).toHaveBeenCalledOnce();
});

it("offers both the waiting task and the chat when each holds a question", async () => {
  state.homeConnected = true;
  state.openChat.mockClear();
  const onOpenTask = await render({ rows: [waiting], turnsWaiting: ["turn-1"] });
  expect(container.textContent).toContain("2 waiting for your answer");
  await act(async () => button("Answer")?.click());
  expect(onOpenTask).toHaveBeenCalledWith("ask");
  await act(async () => button("Open the chat")?.click());
  expect(state.openChat).toHaveBeenCalledOnce();
});
