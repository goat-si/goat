import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { decisionInbox } from "../../state/decisionInbox";
import { useSidebar } from "../ui/sidebar";

export function DecisionInboxSidebarRow() {
  const { count, total } = useAtomValue(decisionInbox.summaryAtom);
  const active = useLocation({ select: (location) => location.pathname === "/decisions" });
  const { isMobile, setOpenMobile } = useSidebar();
  // Items a parent agent is handling stay reachable, without counting as waiting on you.
  if (total === 0) return null;

  return (
    <li className="list-none" data-thread-selection-safe>
      <Link
        to="/decisions"
        aria-current={active ? "page" : undefined}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
        }}
        className={cn(
          "flex min-h-9 items-center rounded-md px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        {count > 0
          ? `${count} ${count === 1 ? "decision" : "decisions"} waiting`
          : `${total} with agents`}
      </Link>
    </li>
  );
}
