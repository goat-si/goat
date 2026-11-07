import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GoatBotProfileDialog, type GoatBotProfileChanges } from "./GoatBotProfileDialog";
import "~/index.css";

const initial = { name: "GOAT Bot", avatar: "🐐", purpose: "" };

it("keeps Save off for a blank name and sends only what the person changed", async () => {
  const onSubmit = vi.fn(async (_changes: GoatBotProfileChanges) => null);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotProfileDialog
      mode="edit"
      initial={initial}
      canSubmit
      onSubmit={onSubmit}
      onClose={onClose}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  const save = page.getByRole("button", { name: "Save" });
  await userEvent.clear(name);
  await userEvent.type(name, "   ");
  await expect.element(save).toBeDisabled();
  await expect.element(page.getByText("The bot needs a name.")).toBeVisible();
  await userEvent.clear(name);
  await userEvent.type(name, " Jarvis ");
  await userEvent.clear(page.getByRole("textbox", { name: "Avatar" }));
  await userEvent.type(page.getByRole("textbox", { name: "Purpose" }), "Watch the deploys.");
  await save.click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    name: "Jarvis",
    avatar: null,
    purpose: "Watch the deploys.",
  });
});

it("shows a refused save in the dialog and keeps the person's text", async () => {
  const onSubmit = vi.fn(async (_changes: GoatBotProfileChanges) => "This request is not allowed.");
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotProfileDialog
      mode="edit"
      initial={initial}
      canSubmit
      onSubmit={onSubmit}
      onClose={onClose}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Jarvis");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("This request is not allowed.");
  await expect.element(name).toHaveValue("Jarvis");
  expect(onClose).not.toHaveBeenCalled();
});

it("cannot save without permission to edit the bot", async () => {
  await using _screen = await render(
    <GoatBotProfileDialog
      mode="edit"
      initial={initial}
      canSubmit={false}
      onSubmit={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
