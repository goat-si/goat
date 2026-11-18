import { EnvironmentId, type ServerConfig, type ServerProvider } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";

// The message a command gets when its computer has no session (rpc/client.ts currentSession).
const NOT_CONNECTED = "Test computer is not connected.";
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
              new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_CONNECTED }),
            ),
          ),
      } as never,
    },
  };
});

import { OnboardingCodexSetup } from "./WelcomeWizard";

// As on a computer whose Codex CLI is signed out: the card offers both setup modes.
const SIGNED_OUT_CODEX = {
  displayName: "Codex",
  enabled: true,
  status: "error",
  installed: true,
  auth: { status: "unauthenticated" },
  models: [],
} as unknown as ServerProvider;

it("shows why changing the Codex setup failed", async () => {
  await using screen = await render(
    <ToastProvider timeout={0}>
      <OnboardingCodexSetup
        environmentId={EnvironmentId.make("env")}
        provider={SIGNED_OUT_CODEX}
        serverConfig={{ settings: { providerInstances: {} } } as unknown as ServerConfig}
        terminalOpen={false}
        onOpenTerminal={() => {}}
        createdAccount={null}
        onAutoStartConsumed={() => {}}
      />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Use existing CLI" }));
  await expect.element(page.getByText("Could not change Codex setup")).toBeVisible();
  await expect.element(page.getByText(NOT_CONNECTED)).toBeVisible();
});
