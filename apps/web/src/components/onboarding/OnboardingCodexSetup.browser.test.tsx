import { EnvironmentId, type ServerConfig, type ServerProvider } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ toast: vi.fn() }));
const NOT_SENT = "Test computer reconnected before this ran, so it was not sent. Try again.";
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: {
        label: "update",
        run: async () =>
          AsyncResult.failure(
            Cause.fail(
              new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_SENT }),
            ),
          ),
      } as never,
    },
  };
});

import { OnboardingCodexSetup } from "./WelcomeWizard";

// As on a computer where Codex is turned off: the card offers both setup modes.
const DISABLED_CODEX = {
  displayName: "Codex",
  enabled: false,
  status: "disabled",
  installed: true,
  auth: { status: "unknown" },
  models: [],
} as unknown as ServerProvider;

it("shows why changing the Codex setup failed", async () => {
  await using screen = await render(
    <OnboardingCodexSetup
      environmentId={EnvironmentId.make("env")}
      provider={DISABLED_CODEX}
      serverConfig={{ settings: { providerInstances: {} } } as unknown as ServerConfig}
      terminalOpen={false}
      onOpenTerminal={() => {}}
      createdAccount={null}
      onAutoStartConsumed={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Use existing CLI" }));
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not change Codex setup",
      description: NOT_SENT,
    }),
  );
});
