import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { WorktreeCheckoutHealthNotice } from "./WorktreeCheckoutHealthNotice";

const command = "Add-MpPreference -ExclusionPath 'C:\\Users\\super\\.goat\\worktrees'";

it("starts folded to its title and toggles the exclusion command", async () => {
  await using _screen = await render(
    <WorktreeCheckoutHealthNotice
      health={{ defender: "scanning", worktreesDirectory: "C:\\Users\\super\\.goat\\worktrees" }}
      hostLabel="MINI"
    />,
  );
  const trigger = page.getByRole("button", { name: "Microsoft Defender scans new worktrees" });

  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText(command)).not.toBeInTheDocument();

  await userEvent.click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText(command)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();

  await userEvent.click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText(command)).not.toBeInTheDocument();
});
