import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { useSidebar } from "../components/ui/sidebar";

export function NotesSidebarRow() {
  const active = useLocation({ select: (location) => location.pathname === "/notes" });
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <li className="list-none" data-thread-selection-safe>
      <Link
        to="/notes"
        search={{}}
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
        Notes
      </Link>
    </li>
  );
}
