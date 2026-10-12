import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { GOAT_BOT_PATH, isGoatBotRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { useGoatBotEnabled } from "./useGoatBotSession";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { Badge } from "../ui/badge";

/** GOAT Bot's pinned place at the top of the thread list. */
export function GoatBotSidebarRow() {
  const { enabled } = useGoatBotEnabled();
  const count = useGoatBotWaitingCount();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const active = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const { isMobile, setOpenMobile } = useSidebar();
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  if (!enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? "page" : undefined}
        onClick={handleClick}
        render={<Link to={GOAT_BOT_PATH} />}
      >
        <GoatBotAvatar size="sm" />
        <span className="flex-1 truncate">GOAT Bot</span>
        {count !== undefined && count > 0 ? (
          <Badge size="sm" variant="secondary">
            {count}
          </Badge>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
