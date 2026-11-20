import { EnvironmentId } from "@goat/contracts";
import { GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import spanish from "../../i18n/translations/es.json";
import { SnoozeMenuButton } from "./SidebarSnoozeMenuButton";

it("localizes the snooze menu and still chooses the same wake time", async () => {
  const onSnooze = vi.fn();
  const now = new Date("2025-02-05T12:00:00").getTime();
  vi.setSystemTime(now);
  using _clock = { [Symbol.dispose]: () => vi.useRealTimers() };
  await using screen = await render(
    <GTProvider locale="es" translations={{ es: spanish }}>
      <SnoozeMenuButton
        open
        environmentId={EnvironmentId.make("test-environment")}
        timestampFormat="locale"
        onOpenChange={() => {}}
        onSnooze={onSnooze}
      />
    </GTProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Posponer hilo", includeHidden: true }))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Personalizado…" })).toBeVisible();
  const preset = page.getByRole("menuitem", { name: /Dentro de 1 hora/ });
  await expect.element(preset).toBeVisible();
  await preset.click();
  const wake = Date.parse(onSnooze.mock.lastCall?.[0].snoozedUntil ?? "");
  expect(wake).toBe(now + 3_600_000);
});
