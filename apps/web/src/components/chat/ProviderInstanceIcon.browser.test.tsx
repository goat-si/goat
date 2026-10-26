import { ProviderDriverKind } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ProviderInstanceIcon, providerInstanceIconLabel } from "./ProviderInstanceIcon";

it.each([
  { driver: "claudeCloud", name: "Claude Cloud" },
  { driver: "cursorCloud", name: "Cursor Cloud" },
  { driver: "devinCloud", name: "Devin Cloud" },
])("$name carries a cloud badge and names its holder", async ({ driver, name }) => {
  await using screen = await render(
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(driver)}
      displayName={name}
      holder="mini"
      iconClassName="size-4"
    />,
    { router: false }, // A bare icon needs no routes.
  );
  const icon = screen.getByRole("img", { name: `${name} · mini` });
  await expect.element(icon).toBeVisible();
  expect(icon.element().querySelector("[data-provider-cloud-badge]")).not.toBeNull();
});

it("keeps local Claude unbadged, so the two read apart without color", async () => {
  await using screen = await render(
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make("claudeAgent")}
      displayName="Claude"
      iconClassName="size-4"
    />,
    { router: false }, // A bare icon needs no routes.
  );
  const icon = screen.getByRole("img", { name: "Claude" });
  await expect.element(icon).toBeVisible();
  expect(icon.element().querySelector("[data-provider-cloud-badge]")).toBeNull();
});

it("shows the name on keyboard focus where the icon stands alone", async () => {
  await using screen = await render(
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make("claudeCloud")}
      displayName="Claude Cloud"
      holder="local"
      iconClassName="size-4"
      focusable
    />,
    { router: false }, // A bare icon needs no routes.
  );
  await userEvent.tab();
  await expect.element(screen.getByRole("img", { name: "Claude Cloud · local" })).toHaveFocus();
  await expect.element(page.getByText("Claude Cloud · local", { exact: true })).toBeVisible();
});

it("labels a renamed cloud instance as cloud", () => {
  expect(
    providerInstanceIconLabel({
      driverKind: ProviderDriverKind.make("claudeCloud"),
      displayName: "Work",
      holder: "mini",
    }),
  ).toBe("Work (cloud) · mini");
});
