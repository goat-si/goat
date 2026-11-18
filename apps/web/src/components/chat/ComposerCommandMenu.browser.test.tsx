import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

it("shows the full active command description when its row truncates it", async () => {
  const description =
    "A long command description explaining precisely what this command does ".repeat(4);
  const item: ComposerCommandItem = {
    id: "plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description,
  };
  await using screen = await render(
    <div style={{ width: 220 }}>
      <ComposerCommandMenu
        listId="commands"
        items={[item]}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="plan"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />
    </div>,
  );
  await expect.element(screen.getByRole("option")).toBeVisible();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(description),
  );
});
