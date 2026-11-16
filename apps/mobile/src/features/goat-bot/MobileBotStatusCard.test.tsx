import React, { act, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
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
import { Atom, AtomRegistry } from "effect/reactivity";
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
// Reads nobody answers: Slack's pushed status, and the bot lists a refusal starts over.
vi.mock("../../state/channels", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const idle = Atom.make(AsyncResult.initial());
  return {
    channelEnvironment: {
      slackSettings: () => "slack",
      slackStatus: () => idle,
      listBots: () => idle,
    },
  };
});
vi.mock("./openAsksRead", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const idle = Atom.make(AsyncResult.initial());
  return { openAsks: () => idle };
});
// The app's computers and their connections, which the refusal follower watches.
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make<unknown>({ isReady: true, entries: new Map() }),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) =>
    key === "slack" ? state.slackQuery : { data: null, error: null, refresh: () => {} },
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-07T12:00:00Z") }));

import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import { MobileBotStatusCard } from "./MobileBotStatusCard";
import { followKeptPerComputerCatalog, resetKeptPerComputerForTests } from "./useKeptPerComputer";

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

async function render(
  props: Partial<React.ComponentProps<typeof MobileBotStatusCard>> = {},
  registry: AtomRegistry.AtomRegistry = AtomRegistry.make(),
) {
  root ??= createRoot(container);
  const onOpenTask = vi.fn();
  await act(async () =>
    root?.render(
      <RegistryContext value={registry}>
        <MobileBotStatusCard
          environmentId={STUDIO}
          member={null}
          rows={[]}
          refreshRows={state.refreshRows}
          turnsWaiting={[]}
          onOpenChat={state.openChat}
          onOpenTask={onOpenTask}
          {...props}
        />
      </RegistryContext>,
    ),
  );
  return onOpenTask;
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);

const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<unknown>;
const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const listed = (ids: ReadonlyArray<string>) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});
const homeLink = (connection: object) => new Map([["env-studio", { connection }]]);
const blocked = (reason: "authentication" | "permission") => ({
  phase: "error",
  failure: { kind: "blocked", reason },
});

/** The app's refusal follower over both computers, as installed when the app starts. */
function following() {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(catalogAtom, listed(["env-studio", "env-laptop"]));
  return { registry, [Symbol.dispose]: stop };
}

it.each(["authentication", "permission"] as const)(
  "says the home did not accept this device after its connection is refused for %s (#3532)",
  async (reason) => {
    using follow = following();
    state.homeConnected = false;
    state.moveTarget = { environmentId: LAPTOP, label: "MacBook" };
    state.changeHome.mockClear();
    try {
      follow.registry.set(presentationsAtom, homeLink(blocked(reason)));
      // The sheet shows another machine; the card still names the home that refused.
      await render({ environmentId: LAPTOP, rows: "unavailable" }, follow.registry);
      expect(container.textContent).toContain("Not working");
      expect(container.textContent).toContain("GOAT on Mac Studio did not accept this device");
      expect(container.textContent).not.toContain("Home machine is offline");
      expect(container.textContent).not.toContain("GPT-5.4");
      await act(async () => button("Make MacBook the home")?.click());
      expect(state.changeHome).toHaveBeenCalledWith(LAPTOP);
    } finally {
      state.moveTarget = null;
    }
  },
);

it("guard: a home that is only offline still says it is offline (#3532)", async () => {
  using follow = following();
  state.homeConnected = false;
  follow.registry.set(
    presentationsAtom,
    homeLink({ phase: "error", failure: { kind: "transport", reason: "network" } }),
  );
  await render({ rows: "unavailable" }, follow.registry);
  expect(container.textContent).toContain("Home machine is offline (Mac Studio)");
  expect(container.textContent).not.toContain("did not accept this device");
});

it("guard: a refusal seen again after the home left the app's computers counts as offline (#3532)", async () => {
  using follow = following();
  state.homeConnected = false;
  follow.registry.set(presentationsAtom, homeLink(blocked("authentication")));
  follow.registry.set(catalogAtom, listed(["env-laptop"]));
  // The removed home's presentation outlives its entry and reports the refusal once more.
  follow.registry.set(presentationsAtom, homeLink(blocked("authentication")));
  await render({ rows: "unavailable" }, follow.registry);
  expect(container.textContent).toContain("Home machine is offline (Mac Studio)");
  expect(container.textContent).not.toContain("did not accept this device");
});

/** The home refused, was removed, refused once more late, and was added back. */
function readdedAfterRefusal(registry: AtomRegistry.AtomRegistry) {
  registry.set(presentationsAtom, homeLink(blocked("authentication")));
  registry.set(catalogAtom, listed(["env-laptop"]));
  registry.set(presentationsAtom, homeLink(blocked("authentication")));
  registry.set(catalogAtom, listed(["env-studio", "env-laptop"]));
  // Back in the catalog, its presentation can still carry the removed connection's last state.
  registry.set(presentationsAtom, homeLink(blocked("authentication")));
}

it("a home removed and added back doesn't inherit the earlier membership's refusal (#3532)", async () => {
  using follow = following();
  state.homeConnected = false;
  readdedAfterRefusal(follow.registry);
  await render({ rows: "unavailable" }, follow.registry);
  expect(container.textContent).toContain("Home machine is offline (Mac Studio)");
  expect(container.textContent).not.toContain("did not accept this device");
});

it("a home added back says it did not accept this device once its new connection is refused (#3532)", async () => {
  using follow = following();
  state.homeConnected = false;
  readdedAfterRefusal(follow.registry);
  follow.registry.set(presentationsAtom, homeLink({ phase: "connecting", error: null }));
  follow.registry.set(presentationsAtom, homeLink(blocked("permission")));
  await render({ rows: "unavailable" }, follow.registry);
  expect(container.textContent).toContain("GOAT on Mac Studio did not accept this device");
  expect(container.textContent).not.toContain("Home machine is offline");
});

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
