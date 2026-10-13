import { ChevronRightIcon } from "~/components/solar";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsSearchTargetId } from "./settingsLayout";

/**
 * Groups secondary settings sections under one "Advanced settings" toggle that
 * starts closed. The sections stay mounted while closed, and the whole group
 * hides when none of them renders. A settings search for any id in
 * `targetIds` opens the group so the section can handle the jump itself.
 */
export function AdvancedSettingsDisclosure({
  targetIds,
  children,
}: {
  readonly targetIds: ReadonlyArray<string>;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const [openedForTarget, setOpenedForTarget] = useState<string | null>(null);
  if (
    searchTargetId !== null &&
    targetIds.includes(searchTargetId) &&
    openedForTarget !== searchTargetId
  ) {
    setOpenedForTarget(searchTargetId);
    if (!open) setOpen(true);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="hidden has-[section]:block">
      <CollapsibleTrigger className="flex min-h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Advanced settings
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="flex flex-col gap-4 pt-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
