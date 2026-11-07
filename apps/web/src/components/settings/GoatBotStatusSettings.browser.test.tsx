import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import { EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");

const state = vi.hoisted(() => ({
  canWrite: true,
  environments: [] as ReadonlyArray<unknown>,
  persist: async (_call: unknown): Promise<{ _tag: "Success" }> => ({ _tag: "Success" }),
}));

vi.mock(import("../goatBot/goatBotHooks"), async (original) => ({
  ...(await original()),
  useGoatBotEnvironments: (() => state.environments) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => (call: unknown) => state.persist(call)) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => state.canWrite,
  useEnvironmentScope: () => state.canWrite,
  useEnvironmentsWithScope: ((entries: ReadonlyArray<{ environmentId: EnvironmentId }>) =>
    new Set(state.canWrite ? entries.map((entry) => entry.environmentId) : [])) as never,
}));

import { GoatBotStatusSettings } from "./GoatBotStatusSettings";

function machine(
  environmentId: EnvironmentId,
  label: string,
  connected: boolean,
  home: GoatBotHomeClaim,
): GoatBotEnvironmentInput {
  return {
    environmentId,
    connected,
    supportsChannelLedger: true,
    primary: environmentId === STUDIO,
    label,
    settingsSnapshot: {},
    homeTarget: {
      environmentId,
      connected,
      supportsHome: true,
      supportsBot: true,
      settingsLoaded: true,
      home,
    },
  };
}

/** Mac Studio is the home and has gone offline; the MacBook is connected. */
function setup(canWrite: boolean) {
  const studioClaim = { environmentId: STUDIO, claimedAt: 1_000, claimId: "claim-studio" };
  state.canWrite = canWrite;
  state.environments = [
    machine(STUDIO, "Mac Studio", false, studioClaim),
    machine(LAPTOP, "MacBook", true, studioClaim),
  ];
  // Each server stores the claim it is sent, and the next settings snapshot carries it back.
  state.persist = async (call) => {
    const { environmentId, input } = call as {
      environmentId: EnvironmentId;
      input: { patch: { goatBotHome: GoatBotHomeClaim } };
    };
    state.environments = (state.environments as GoatBotEnvironmentInput[]).map((entry) =>
      entry.environmentId === environmentId && entry.homeTarget
        ? { ...entry, homeTarget: { ...entry.homeTarget, home: input.patch.goatBotHome } }
        : entry,
    );
    return { _tag: "Success" };
  };
}

it("shows an offline home in Settings and moves GOAT Bot to a connected machine", async () => {
  setup(true);
  await using screen = await render(<GoatBotStatusSettings />);

  await expect.element(screen.getByText("Not working")).toBeVisible();
  await expect.element(screen.getByText("Home machine is offline (Mac Studio)")).toBeVisible();
  await page.getByRole("button", { name: "Make MacBook the home" }).click();

  await screen.rerender(<GoatBotStatusSettings />);
  await expect.element(screen.getByText("Answers on MacBook")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Make MacBook the home" }))
    .not.toBeInTheDocument();
});

it("tells a viewer who cannot change the home what is wrong without offering the move", async () => {
  setup(false);
  await using screen = await render(<GoatBotStatusSettings />);

  await expect.element(screen.getByText("Home machine is offline (Mac Studio)")).toBeVisible();
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
});
