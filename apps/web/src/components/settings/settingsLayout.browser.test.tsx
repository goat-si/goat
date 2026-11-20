import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../../hooks/useSettings";
import { I18nProvider } from "../../i18n/I18nProvider";
import { startI18n } from "../../i18n/runtime";
import { SettingResetButton } from "./settingsLayout";

function setup() {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  startI18n();
}

it("names the Reset button in the interface language", async () => {
  setup();
  await using screen = await render(
    <I18nProvider>
      <SettingResetButton label="언어" onClick={() => {}} />
    </I18nProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Reset 언어 to default" }))
    .toBeInTheDocument();

  await persistClientSettingsPatch({ language: "ko" }, async () => {});

  await expect
    .element(screen.getByRole("button", { name: "언어 기본값 복원" }))
    .toBeInTheDocument();
});
