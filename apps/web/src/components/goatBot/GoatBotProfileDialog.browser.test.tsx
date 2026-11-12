import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GoatBotProfileDialog, type GoatBotProfileChanges } from "./GoatBotProfileDialog";
import "~/index.css";

const initial = { name: "GOAT Bot", avatar: "🐐", purpose: "" };

it("refuses to save a blank name and sends only what the person changed", async () => {
  const onSubmit = vi.fn(async (_changes: GoatBotProfileChanges) => null);
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotProfileDialog initial={initial} canSubmit onSubmit={onSubmit} onClose={onClose} />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  const save = page.getByRole("button", { name: "Save" });
  await userEvent.clear(name);
  await userEvent.type(name, "   ");
  await save.click();
  await expect.element(page.getByText("The bot needs a name.")).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
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

it("says a blank name is missing only once the person leaves the field or saves", async () => {
  const onSubmit = vi.fn(async (_changes: GoatBotProfileChanges) => null);
  await using _screen = await render(
    <GoatBotProfileDialog
      initial={{ name: "", avatar: null, purpose: "" }}
      canSubmit
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  const missing = page.getByText("The bot needs a name.");
  await expect.element(name).toBeVisible();
  await expect.element(missing).not.toBeInTheDocument();
  await expect.element(name).not.toHaveAttribute("aria-invalid", "true");
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(missing).toBeVisible();
  await expect.element(name).toHaveAttribute("aria-invalid", "true");
  await expect.element(name).toHaveFocus();
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.type(name, "Docs");
  await expect.element(missing).not.toBeInTheDocument();
});

it("checks a cleared name when the person leaves the field", async () => {
  await using _screen = await render(
    <GoatBotProfileDialog
      initial={initial}
      canSubmit
      onSubmit={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  const missing = page.getByText("The bot needs a name.");
  await userEvent.clear(name);
  await expect.element(missing).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("textbox", { name: "Purpose" }));
  await expect.element(missing).toBeVisible();
});

it("checks a name typed then cleared when the person leaves the field", async () => {
  await using _screen = await render(
    <GoatBotProfileDialog
      initial={{ name: "", avatar: null, purpose: "" }}
      canSubmit
      onSubmit={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  const name = page.getByRole("textbox", { name: "Name" });
  const missing = page.getByText("The bot needs a name.");
  await userEvent.type(name, "Docs");
  await userEvent.clear(name);
  await expect.element(missing).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("textbox", { name: "Avatar" }));
  await expect.element(missing).toBeVisible();
});

it("shows a refused save in the dialog and keeps the person's text", async () => {
  const onSubmit = vi.fn(async (_changes: GoatBotProfileChanges) => "This request is not allowed.");
  const onClose = vi.fn();
  await using _screen = await render(
    <GoatBotProfileDialog initial={initial} canSubmit onSubmit={onSubmit} onClose={onClose} />,
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
      initial={initial}
      canSubmit={false}
      onSubmit={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
    { router: false }, // The dialog uses no links or navigation.
  );
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
