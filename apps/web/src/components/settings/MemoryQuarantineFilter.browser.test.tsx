import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { MemoryQuarantineFilter } from "./MemoryQuarantineFilter";

it("shows the effective quarantine filter during search and restores the browse preference", async () => {
  function Fixture() {
    const [checked, setChecked] = useState(true);
    const [searching, setSearching] = useState(false);
    return (
      <>
        <MemoryQuarantineFilter
          checked={checked}
          searching={searching}
          onCheckedChange={setChecked}
        />
        <button onClick={() => setSearching(!searching)}>Toggle search</button>
      </>
    );
  }
  await using screen = await render(<Fixture />);
  const filter = screen.getByRole("switch", { name: "Include quarantined memories" });
  await expect.element(filter).toHaveAttribute("aria-checked", "true");
  await screen.getByRole("button", { name: "Toggle search" }).click();
  await expect.element(filter).toHaveAttribute("aria-checked", "false");
  await expect.element(filter).toBeDisabled();
  await expect
    .element(
      screen.getByText(
        "Quarantined memories are excluded from search. Clear search to review them.",
      ),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "Toggle search" }).click();
  await expect.element(filter).toHaveAttribute("aria-checked", "true");
});
