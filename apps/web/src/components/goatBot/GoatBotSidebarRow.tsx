import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { GOAT_BOT_PATH, isGoatBotRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GOAT_BOT_TITLE } from "./GoatBotChatView";

/** GOAT Bot's pinned place at the top of the thread list. */
export function GoatBotSidebarRow() {
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const active = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
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
        render={
          botRef === null ? (
            <Link to={GOAT_BOT_PATH} />
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: botRef.environmentId, threadId: botRef.threadId }}
            />
          )
        }
      >
        <GoatBotAvatar size="sm" />
        <span className="flex-1 truncate">{GOAT_BOT_TITLE}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
