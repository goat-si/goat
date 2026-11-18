import "~/index.css";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
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

it("lets the first and last suggestions be clicked when the anchor is near the window top", async () => {
  const onSelect = vi.fn();
  const items: ComposerCommandItem[] = Array.from({ length: 18 }, (_, i) => ({
    id: String(i),
    type: "slash-command",
    command: "plan",
    label: `Suggestion ${i + 1}`,
    description: "Switch mode",
  }));
  function Fixture() {
    const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
    return (
      <div ref={setAnchor} className="fixed top-2 left-4 w-80 [--chat-composer-drawer-inset:0]">
        <ComposerCommandMenuLayer anchor={anchor}>
          <ComposerCommandMenu
            listId="short-window-commands"
            items={items}
            resolvedTheme="light"
            isLoading={false}
            triggerKind="slash-command"
            activeItemId={null}
            onHighlightedItemChange={() => {}}
            onSelect={onSelect}
          />
        </ComposerCommandMenuLayer>
      </div>
    );
  }

  await using _screen = await render(<Fixture />);
  const first = page.getByRole("option", { name: /^Suggestion 1\b/ });
  await expect.element(first).toBeVisible();
  const drawer = first.element().closest('[data-composer-drawer-layer="true"]');
  const viewport = drawer?.querySelector('[data-slot="scroll-area-viewport"]');
  expect(viewport).toBeInstanceOf(HTMLElement);
  await vi.waitFor(() => {
    const rect = drawer?.getBoundingClientRect();
    expect(rect?.top).toBeGreaterThanOrEqual(0);
    expect(viewport?.clientHeight).toBeLessThan(viewport?.scrollHeight ?? 0);
  });
  await first.click();
  await page.getByRole("option", { name: /^Suggestion 18\b/ }).click();
  expect(onSelect.mock.calls.map(([item]) => item.id)).toEqual(["0", "17"]);
});
