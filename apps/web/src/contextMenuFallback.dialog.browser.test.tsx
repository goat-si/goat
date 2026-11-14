import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../test/render";
import { Dialog, DialogPopup, DialogTitle } from "./components/ui/dialog";
import { Sheet, SheetPopup, SheetTitle } from "./components/ui/sheet";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";

const items = [
  { id: "work", label: "Show work" },
  { id: "pin", label: "Pin" },
];

function Host(props: { readonly kind: "dialog" | "sheet" }) {
  const [open, setOpen] = useState(false);
  const opener = (
    <button type="button" onClick={() => void showContextMenuFallback(items)}>
      Actions
    </button>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open host
      </button>
      {props.kind === "dialog" ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup>
            <DialogTitle>Host</DialogTitle>
            {opener}
          </DialogPopup>
        </Dialog>
      ) : (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetPopup>
            <SheetTitle>Host</SheetTitle>
            {opener}
          </SheetPopup>
        </Sheet>
      )}
    </>
  );
}

// Every sheet and dialog in the app is Base UI's Dialog primitive, so these two hosts stand for all.
it.each(["dialog", "sheet"] as const)(
  "Escape inside a %s closes only the fallback menu and returns focus to its opener",
  async (kind) => {
    await using _screen = await render(<Host kind={kind} />, { router: false }); // No route needed.
    using _menu = { [Symbol.dispose]: dismissContextMenu };
    await userEvent.click(page.getByRole("button", { name: "Open host" }));
    const host = page.getByRole("dialog");
    await expect.element(host).toBeVisible();
    await vi.waitFor(() => expect(host.element().contains(document.activeElement)).toBe(true));
    const actions = page.getByRole("button", { name: "Actions" });
    actions.element().focus();
    await userEvent.keyboard("{Enter}");
    const showWork = page.getByRole("menuitem", { name: "Show work" });
    await expect.element(showWork).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(showWork).not.toBeInTheDocument();
    await expect.element(actions).toHaveFocus();
    // Still open, not merely visible while an exit transition runs.
    await expect.element(host).toHaveAttribute("data-open");
  },
);
