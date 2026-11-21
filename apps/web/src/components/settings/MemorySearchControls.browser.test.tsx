import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../../hooks/useSettings";
import { I18nProvider } from "../../i18n/I18nProvider";
import { startI18n } from "../../i18n/runtime";
import { MemoryRecordsError, MemorySearchControls } from "./MemorySearchControls";

it("translates memory search controls without changing a typed query or remote error", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, language: "en" });
  startI18n();
  const search = vi.fn();
  const retry = vi.fn();

  function SearchFixture() {
    const [value, setValue] = useState("");
    return (
      <>
        <MemorySearchControls
          value={value}
          canClear={value !== ""}
          onChange={setValue}
          onSearch={() => search(value)}
          onClear={() => setValue("")}
        />
        <MemoryRecordsError searching error="Synthetic search error" onRetry={retry} />
      </>
    );
  }

  await using screen = await render(
    <I18nProvider>
      <SearchFixture />
    </I18nProvider>,
  );
  const englishInput = screen.getByRole("textbox", { name: "Search memories" });
  await expect.element(englishInput).toHaveAttribute("placeholder", "Search memories");
  await englishInput.fill("Synthetic note");
  try {
    await persistClientSettingsPatch({ language: "es" }, async () => {});
    const spanishInput = screen.getByRole("textbox", { name: "Buscar en la memoria" });
    await expect.element(spanishInput).toHaveAttribute("placeholder", "Buscar en la memoria");
    await expect.element(spanishInput).toHaveValue("Synthetic note");
    await expect.element(screen.getByText("Buscar en la memoria", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Buscar", exact: true }).click();
    expect(search).toHaveBeenCalledExactlyOnceWith("Synthetic note");

    await expect.element(screen.getByText("No se pudo cargar la memoria")).toBeVisible();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Synthetic search error");
    await screen.getByRole("button", { name: "Reintentar" }).click();
    expect(retry).toHaveBeenCalledTimes(1);

    await screen.getByRole("button", { name: "Borrar búsqueda" }).click();
    await expect.element(spanishInput).toHaveValue("");
  } finally {
    await persistClientSettingsPatch({ language: "en" }, async () => {});
  }
});
