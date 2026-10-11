import { Link, useLocation } from "@tanstack/react-router";
import { useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GOAT_BOT_TITLE } from "./GoatBotChatView";

export const GOAT_BOT_ROUTE = "/bot";

/** GOAT Bot's pinned place at the top of the thread list. */
export function GoatBotSidebarRow() {
  const active = useLocation({ select: (location) => location.pathname === GOAT_BOT_ROUTE });
  const { isMobile, setOpenMobile } = useSidebar();
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? "page" : undefined}
        onClick={handleClick}
        render={<Link to={GOAT_BOT_ROUTE} />}
      >
        <GoatBotAvatar size="sm" />
        <span className="flex-1 truncate">{GOAT_BOT_TITLE}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
