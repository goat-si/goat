import { getCommandPaletteOpener } from "../commandPaletteBus";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useRouter } from "@tanstack/react-router";
import { XIcon } from "~/components/solar";
import { useRef, useState, type ReactNode } from "react";

import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Large modal for the Settings and Usage routes. Esc, the close button, or a press on the
 * backdrop returns to the page that opened it. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts.
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const router = useRouter();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // Pointer dismissal leaves focus alone to avoid a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  // Leaving the page without closing (Navigation: Back) unmounts a focused field during a
  // commit, when React no longer delivers its blur, so commit-on-blur rows would drop what was
  // typed. Blur text fields before the navigation renders; other controls keep their focus.
  const [bindPopupRef] = useState(() => (node: HTMLDivElement | null) => {
    popupRef.current = node;
    if (node === null) return undefined;
    return router.subscribe("onBeforeLoad", ({ pathChanged }) => {
      const focused = document.activeElement;
      if (pathChanged && focused?.matches("input, textarea, [contenteditable]")) {
        blurFocusedWithin(popupRef.current);
      }
    });
  });
  const [opener] = useState(
    () =>
      getCommandPaletteOpener() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );

  return (
    <DialogPrimitive.Root
      open={open}
      // Portaled layers outside this tree (toasts, Clerk, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        // Base UI's dismiss handler fires on held Esc repeats after a nested popup closes.
        if (eventDetails.reason === "escape-key" && eventDetails.event.repeat) {
          return eventDetails.cancel();
        }
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        blurFocusedWithin(popupRef.current);
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          className="fixed inset-0 z-modal flex items-center justify-center [-webkit-app-region:no-drag] sm:p-6 lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={bindPopupRef}
            initialFocus={popupRef}
            finalFocus={(closeType) => {
              if (closeType !== "keyboard" || !opener?.isConnected) return false;
              if (!opener.closest("[inert]")) return opener;
              const area = opener.closest<HTMLElement>("[data-workspace-area]");
              if (area?.dataset.workspaceArea)
                requestWorkspaceFocus({ area: area.dataset.workspaceArea });
              return false;
            }}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            data-glass-pane="pane"
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-safe max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function blurFocusedWithin(container: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && container?.contains(focused)) focused.blur();
}

export function AppRouteModalClose() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label="Close"
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
