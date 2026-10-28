import { EllipsisIcon, ListChecksIcon } from "~/components/solar";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SortableSidebarMarker } from "./SidebarListMarkers";

const CLEAR_READ_LABEL = "Clear read threads";

export function SidebarPriorityHeader(props: {
  readonly count: number;
  readonly canMarkAllRead: boolean;
  readonly onMarkAllRead: () => void;
  readonly canClearRead: boolean;
  readonly onClearRead: () => void;
}) {
  return (
    <SortableSidebarMarker
      marker="priority-header"
      data-testid="sidebar-priority-header"
      className="mx-0.5 flex h-8 items-center justify-between px-2"
    >
      <span className="text-xs font-medium text-sidebar-foreground">Priority ({props.count})</span>
      <div className="flex items-center gap-0.5">
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost-muted" size="icon-micro" aria-label="Priority actions" />
            }
          >
            <EllipsisIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem disabled={!props.canMarkAllRead} onClick={props.onMarkAllRead}>
              Mark all as read
            </MenuItem>
          </MenuPopup>
        </Menu>
        {props.canClearRead ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label={CLEAR_READ_LABEL}
                  onClick={props.onClearRead}
                >
                  <ListChecksIcon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">{CLEAR_READ_LABEL}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </SortableSidebarMarker>
  );
}
