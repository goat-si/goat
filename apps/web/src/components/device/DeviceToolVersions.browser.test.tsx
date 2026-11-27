import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../../hooks/useSettings";
import { I18nProvider } from "../../i18n/I18nProvider";
import { startI18n } from "../../i18n/runtime";
import { DeviceToolVersions } from "./DeviceToolVersions";

it("updates the device status and its accessible action when the language changes", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  startI18n();
  const missing = { requiredVersion: "1.0.0", installedVersions: [], runningVersion: null };
  await using screen = await render(
    <I18nProvider>
      <DeviceToolVersions kind="hub" tools={{ hub: missing, agent: missing }} />
    </I18nProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Device hub: not installed. Show details" }))
    .toHaveTextContent("Not installed");

  await persistClientSettingsPatch({ language: "zh" }, async () => {});
  await expect
    .element(screen.getByRole("button", { name: "设备中心：未安装。查看详情" }))
    .toHaveTextContent("未安装");
});
