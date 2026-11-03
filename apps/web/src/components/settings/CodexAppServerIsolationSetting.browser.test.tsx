import { render } from "../../../test/render";
import { CODEX_APP_SERVER_ISOLATION_DEFAULT, DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  capabilities: [] as Array<{ codexAppServerIsolation?: boolean }>,
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    connectedEnvironments: state.capabilities.map((capabilities, index) => ({
      environmentId: `env-${index}`,
      serverConfig: { environment: { capabilities } },
    })),
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_SERVER_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control, status }) => (
    <div>
      {control}
      <p>{status}</p>
    </div>
  ),
  SettingResetButton: () => <></>,
}));

import { CodexAppServerIsolationSetting } from "./CodexAppServerIsolationSetting";

function setup(capabilities: Array<{ codexAppServerIsolation?: boolean }>) {
  state.update.mockReset();
  state.capabilities = capabilities;
}

describe("Codex app-server isolation setting", () => {
  it("is disabled unless every selected environment advertises the capability", async () => {
    setup([{ codexAppServerIsolation: true }, {}]);
    await using _screen = await render(<CodexAppServerIsolationSetting />);
    await expect.element(page.getByRole("combobox", { name: "Codex app-servers" })).toBeDisabled();
    await expect
      .element(page.getByText("All selected environments must support separate Codex app-servers."))
      .toBeVisible();
  });

  it("writes the chosen isolation and marks the shipped default", async () => {
    setup([{ codexAppServerIsolation: true }]);
    await using _screen = await render(<CodexAppServerIsolationSetting />);
    const select = page.getByRole("combobox", { name: "Codex app-servers" });
    await expect.element(select).toBeEnabled();
    await userEvent.click(select);
    const other = CODEX_APP_SERVER_ISOLATION_DEFAULT === "shared" ? "thread" : "shared";
    await expect
      .element(
        page.getByRole("option", {
          name:
            CODEX_APP_SERVER_ISOLATION_DEFAULT === "shared"
              ? "Shared (default)"
              : "One per thread (default)",
        }),
      )
      .toBeVisible();
    await userEvent.click(
      page.getByRole("option", { name: other === "thread" ? "One per thread" : "Shared" }),
    );
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ codexAppServerIsolation: other });
  });
});
