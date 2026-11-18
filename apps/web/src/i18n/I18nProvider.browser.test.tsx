import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts";
import { useGT } from "gt-react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";
import { I18nProvider } from "./I18nProvider";
import { startI18n, whenLocaleReady } from "./runtime";

// Reading the catalog fails the way a chunk that cannot load does.
vi.mock("./translations/zh.json", () => ({
  get default(): unknown {
    throw new Error("catalog chunk unavailable");
  },
}));

function SettingsHeading() {
  const gt = useGT();
  return <h1>{gt("Settings")}</h1>;
}

function setup() {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  startI18n();
}

const chooseLanguage = (language: string) =>
  persistClientSettingsPatch({ language }, async () => {});

it("switches the UI to the language chosen in Settings", async () => {
  setup();
  await using screen = await render(
    <I18nProvider>
      <SettingsHeading />
    </I18nProvider>,
  );
  await expect.element(screen.getByRole("heading", { name: "Settings" })).toBeVisible();

  await chooseLanguage("es");

  await expect.element(screen.getByRole("heading", { name: "Ajustes" })).toBeVisible();
  expect(document.documentElement.lang).toBe("es");

  await chooseLanguage("en");
  await expect.element(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
});

it("stays in English without an error when a language's catalog fails to load", async () => {
  setup();
  await using screen = await render(
    <I18nProvider>
      <SettingsHeading />
    </I18nProvider>,
  );

  await chooseLanguage("zh");
  await whenLocaleReady();

  await expect.element(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
});
