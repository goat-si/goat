import { useGT } from "gt-react";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { XIcon } from "~/components/solar";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { registerCommands } from "../../shortcuts/dispatcher";
import { closeAppPage, useCloseAppModal } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

const ESCAPE_OWNERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot$="popup"]';

function blurFocusedWithin(container: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && container?.contains(focused)) focused.blur();
}

// Escape leaves Settings when nothing else (a popup, the search field, a dialog) claimed it.
function registerSettingsEscape(router: AnyRouter): () => void {
  return registerCommands(
    {},
    {
      observe: (event, consumed) => {
        if (
          consumed ||
          event.repeat ||
          event.isComposing ||
          event.keyCode === 229 ||
          event.key !== "Escape"
        )
          return;
        if (event.target instanceof Element && event.target.closest(ESCAPE_OWNERS)) return;
        event.preventDefault();
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) activeElement.blur();
        void closeAppPage(router);
      },
    },
  );
}

/**
 * GOAT shows Settings as a full page in place of the main view, with the settings sections in the
 * app sidebar (fork delta `settings-page`).
 */
export function SettingsPageShell({
  pathname,
  actions,
  children,
}: {
  pathname: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const gt = useGT();
  const router = useRouter();
  const closeSettings = useCloseAppModal();
  // Created once so re-renders never re-register the command or navigation blur listener.
  // Leaving Settings without closing (Navigation: Back) unmounts focused fields during commit,
  // when React no longer delivers blur; onBeforeLoad runs before unmount even after a redirect.
  const [escapeCommandRef] = useState(() => (node: HTMLDivElement | null) => {
    if (node === null) return undefined;
    const disposeEscape = registerSettingsEscape(router);
    const disposeBeforeLoad = router.subscribe("onBeforeLoad", ({ pathChanged }) => {
      const focused = document.activeElement;
      if (pathChanged && focused?.matches("input, textarea, [contenteditable]")) {
        blurFocusedWithin(node);
      }
    });
    return () => {
      disposeEscape();
      disposeBeforeLoad();
    };
  });

  return (
    <SidebarInset
      {...workspaceAreaProps("settings", 1, "Settings content")}
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate"
    >
      <div
        ref={escapeCommandRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      >
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <SettingsBreadcrumb pathname={pathname} />
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {actions}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={gt("Close settings")}
                      onClick={() => void closeSettings()}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}
