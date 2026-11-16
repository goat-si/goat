import { resolveGoatBotAvailability } from "@goat/client-runtime/goatBot";
import { EnvironmentId, type BotProfile } from "@goat/contracts";
import { type ReactNode, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

import "~/index.css";

vi.unmock("./useGoatBotComputerReadable");

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");
const SENTENCE = "GOAT on Mac Studio did not accept this device";
const PAIR_AGAIN = "Pair this device with Mac Studio again to send messages.";

interface Connection {
  readonly phase: string;
  readonly failure: { readonly reason: string } | null;
}

const state = vi.hoisted(() => ({
  presentations: [] as ReadonlyArray<unknown>,
  primaryId: null as string | null,
  revoked: false,
  listeners: new Set<() => void>(),
  version: 0,
}));

function useTick() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
}
async function change(apply: () => void) {
  apply();
  await act(() => {
    state.version += 1;
    for (const listener of state.listeners) listener();
  });
}
const byId = (environmentId: string | null) =>
  state.presentations.find(
    (entry) => (entry as { environmentId: string }).environmentId === environmentId,
  ) ?? null;

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => {
    useTick();
    return { isReady: true, environments: state.presentations };
  }) as never,
  useEnvironment: ((environmentId: string | null) => {
    useTick();
    return byId(environmentId);
  }) as never,
  readEnvironment: ((environmentId: string) => byId(environmentId)) as never,
  readPrimaryEnvironmentId: (() => state.primaryId) as never,
  usePrimaryEnvironmentId: (() => {
    useTick();
    return state.primaryId;
  }) as never,
}));
vi.mock("~/environments/primary/sessionCheck", () => ({
  primarySessionCheck: {
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    revoked: () => state.revoked,
  },
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));

import { GoatBotChatView } from "./GoatBotChatView";
import { useGoatBotEnvironments } from "./goatBotHooks";
import { GoatBotMainProfileContext } from "./goatBotMemberContext";

const MAIN = { botId: "bot-main", role: "main", name: "Goatie" } as unknown as BotProfile;
const CLAIM = { environmentId: STUDIO, claimedAt: 1_000, claimId: "claim-studio" };

const connected: Connection = { phase: "connected", failure: null };
const dropped: Connection = { phase: "reconnecting", failure: { reason: "transport" } };
const blocked: Connection = { phase: "error", failure: { reason: "authentication" } };

function presentation(
  environmentId: EnvironmentId,
  label: string,
  connection: Connection,
  claim: typeof CLAIM | null,
) {
  return {
    environmentId,
    label,
    connection,
    serverConfig: {
      environment: { label, capabilities: { channelLedger: true, goatBotHome: true } },
      settings: { goatBotHome: claim },
    },
  };
}

interface Scenario {
  readonly presentations: ReadonlyArray<unknown>;
  readonly primaryId: EnvironmentId;
  readonly revoked: boolean;
}

function setup(scenario: Scenario) {
  state.presentations = scenario.presentations;
  state.primaryId = scenario.primaryId;
  state.revoked = scenario.revoked;
  state.listeners.clear();
  state.version = 0;
}

function Harness() {
  const environments = useGoatBotEnvironments();
  const availability = resolveGoatBotAvailability({
    environments,
    botRef: null,
    ensure: { state: "idle" },
  });
  return (
    <GoatBotMainProfileContext value={MAIN}>
      <GoatBotChatView
        availability={availability}
        canOperate
        rows={[]}
        onSend={() => {}}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
        homeMove={{ label: "MacBook", busy: false, onMove: () => {} }}
      />
    </GoatBotMainProfileContext>
  );
}

const refusals: ReadonlyArray<[string, Scenario, boolean]> = [
  [
    "this tab's own server said its session is gone",
    {
      presentations: [presentation(STUDIO, "Mac Studio", dropped, CLAIM)],
      primaryId: STUDIO,
      revoked: true,
    },
    true,
  ],
  [
    "a bearer home blocked this device",
    {
      presentations: [
        presentation(LAPTOP, "MacBook", connected, CLAIM),
        presentation(STUDIO, "Mac Studio", blocked, CLAIM),
      ],
      primaryId: LAPTOP,
      revoked: false,
    },
    true,
  ],
  [
    "an unclaimed primary that refused this device",
    {
      presentations: [presentation(STUDIO, "Mac Studio", dropped, null)],
      primaryId: STUDIO,
      revoked: true,
    },
    false,
  ],
];

it.each(refusals)(
  "the bot chat says GOAT on Mac Studio did not accept this device (%s) in its banner, header and empty-chat notice, never offline, and keeps the move (#3550, access)",
  async (_refusal, scenario, claimed) => {
    setup(scenario);
    await using screen = await render(<Harness />);
    const banner = screen.getByRole("status").filter({ hasText: SENTENCE });
    await expect.element(banner).toHaveTextContent(SENTENCE);
    // The banner and the notice title both carry the sentence in an empty chat.
    expect(screen.getByText(SENTENCE, { exact: true }).elements()).toHaveLength(2);
    await expect.element(screen.getByText(PAIR_AGAIN, { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("Didn't accept this device", { exact: true }))
      .toBeVisible();
    if (claimed)
      await expect
        .element(screen.getByRole("button", { name: "Move Goatie to MacBook" }))
        .toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("isn't connected");
    expect(text).not.toContain("is offline");
    expect(screen.getByText("Offline", { exact: true }).elements()).toHaveLength(0);

    await change(() => {
      state.revoked = false;
      state.presentations = state.presentations.map((entry) =>
        (entry as { environmentId: string }).environmentId === STUDIO
          ? { ...(entry as object), connection: connected }
          : entry,
      );
    });
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Connecting to Goatie…" }))
      .toBeVisible();
    await expect.element(screen.getByText("Connecting…", { exact: true })).toBeVisible();
    expect(screen.getByText(SENTENCE, { exact: true }).elements()).toHaveLength(0);
  },
);

const notRefused: ReadonlyArray<[string, Scenario, string]> = [
  [
    "a dropped socket the server has not refused",
    {
      presentations: [presentation(STUDIO, "Mac Studio", dropped, CLAIM)],
      primaryId: STUDIO,
      revoked: false,
    },
    "Goatie runs on Mac Studio, which isn't connected.",
  ],
  [
    "a home removed from this app while another computer refuses this device",
    {
      presentations: [presentation(LAPTOP, "MacBook", blocked, CLAIM)],
      primaryId: LAPTOP,
      revoked: false,
    },
    "Goatie's home (env-stud) isn't a computer this app knows.",
  ],
];

it.each(notRefused)(
  "an unreachable or removed home is never called a refusal (%s) (#3550, guard)",
  async (_state, scenario, line) => {
    setup(scenario);
    await using screen = await render(<Harness />);
    await expect
      .element(screen.getByRole("status").filter({ hasText: line }))
      .toHaveTextContent(line);
    await expect.element(screen.getByText("Offline", { exact: true })).toBeVisible();
    expect(screen.container.textContent ?? "").not.toContain("did not accept");
  },
);
