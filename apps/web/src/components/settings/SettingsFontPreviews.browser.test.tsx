import { GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { SUPPORTED_LOCALES } from "../../i18n/locales";
import { PromptFontPreview } from "./SettingsFontPreviews";

it.each(SUPPORTED_LOCALES)(
  "keeps the skill and both file links interactive in %s",
  async (locale) => {
    const { default: catalog } = await import(`../../i18n/translations/${locale}.json`);
    await using screen = await render(
      <GTProvider locale={locale} translations={{ [locale]: catalog }}>
        <PromptFontPreview />
      </GTProvider>,
    );
    await expect.element(screen.getByRole("button", { name: /frontend-design/ })).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: /apps\/web\/src\/terminal\/ghostty\/surface\.test\.ts/,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: /apps\/web\/src\/components\/settings\/SettingsPanels\.tsx/,
        }),
      )
      .toBeVisible();
  },
);
