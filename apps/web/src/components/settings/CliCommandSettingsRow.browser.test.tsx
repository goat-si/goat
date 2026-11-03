import type { DesktopCliCommandState } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render, stubGlobal } from "../../../test/render";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";

it.each([false, true])(
  "blocks a shadowed install but permits removal (#27286), installed=%s",
  async (installed) => {
    const state: DesktopCliCommandState = {
      supported: true,
      installedPath: installed ? "/home/test/.local/bin/goat" : null,
      onPath: false,
      launcherPath: "/home/test/.goat/bin/goat",
      shadowedBy: "/usr/local/bin/goat",
    };
    const uninstall = vi.fn(async () => state);
    using _bridge = stubGlobal("desktopBridge", {
      cliCommand: {
        getState: vi.fn(async () => state),
        install: vi.fn(async () => state),
        uninstall,
      },
      getLocalEnvironmentEnabled: () => true,
      getLocalEnvironmentBootstraps: () => [],
    });
    await using screen = await render(<CliCommandSettingsRow />);
    const button = screen.getByRole("button", { name: installed ? "Remove" : "Install" });
    if (installed) {
      await expect.element(button).toBeEnabled();
      await button.click();
      expect(uninstall).toHaveBeenCalledOnce();
    } else {
      await expect.element(button).toBeDisabled();
    }
  },
);
