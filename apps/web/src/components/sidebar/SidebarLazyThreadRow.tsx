import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ComponentProps, type ReactNode, useState } from "react";

import { observeIntersection } from "~/lib/observeIntersection";
import { cn } from "~/lib/utils";
import { animateSidebarLayoutChanges } from "../Sidebar.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED, SortableThreadRow } from "./SidebarThreadRow";

const SIDEBAR_LAZY_ROW_OVERSCAN_PX = 480;
const SIDEBAR_SCROLLER = '[data-slot="scroll-area-viewport"]';

function isNearScroller(node: HTMLElement, scroller: Element | null): boolean {
  const bounds = scroller?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
    height: window.innerHeight,
  };
  // A hidden sidebar has no box yet; the observer mounts rows once it shows.
  if (bounds.height === 0) return false;
  const rect = node.getBoundingClientRect();
  return (
    rect.bottom >= bounds.top - SIDEBAR_LAZY_ROW_OVERSCAN_PX &&
    rect.top <= bounds.bottom + SIDEBAR_LAZY_ROW_OVERSCAN_PX
  );
}

/**
 * Stands in for a sidebar row until it nears the sidebar's scroll viewport, then renders the row
 * and keeps it. The placeholder keeps the row's sortable id, list key, and keyboard target so
 * drag projection, pointer hit-testing, and arrow-key navigation still see every row.
 */
export function SidebarLazyRow(props: {
  rowKey: string;
  label: string;
  variant: "card" | "slim";
  navigationParent?: string | undefined;
  eager: boolean;
  children: ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  if (props.eager && !revealed) setRevealed(true);
  if (revealed || props.eager) return props.children;
  return (
    <SidebarRowPlaceholder
      rowKey={props.rowKey}
      label={props.label}
      variant={props.variant}
      navigationParent={props.navigationParent}
      onReveal={() => setRevealed(true)}
    />
  );
}

function SidebarRowPlaceholder(props: {
  rowKey: string;
  label: string;
  variant: "card" | "slim";
  navigationParent: string | undefined;
  onReveal: () => void;
}) {
  const { onReveal } = props;
  const { setNodeRef, transform, transition } = useSortable({
    id: props.rowKey,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // Measured during commit so rows already in view mount before the first paint.
  const attach = (node: HTMLLIElement) => {
    setNodeRef(node);
    const scroller = node.closest(SIDEBAR_SCROLLER);
    if (isNearScroller(node, scroller)) {
      onReveal();
      return () => setNodeRef(null);
    }
    const stopObserving = observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) onReveal();
      },
      { root: scroller, rootMargin: `${SIDEBAR_LAZY_ROW_OVERSCAN_PX}px 0px` },
    );
    return () => {
      stopObserving();
      setNodeRef(null);
    };
  };
  return (
    <li
      ref={attach}
      data-thread-item={props.rowKey}
      data-sidebar-lazy-row=""
      className={cn("list-none", props.variant === "card" && "py-0.5")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={props.rowKey}
        data-sidebar-parent={props.navigationParent}
        aria-label={props.label}
        className={props.variant === "card" ? "h-[3.375rem]" : "h-9"}
        onFocus={onReveal}
      />
    </li>
  );
}

export function LazySortableThreadRow(props: ComponentProps<typeof SortableThreadRow>) {
  return (
    <SidebarLazyRow
      rowKey={props.sortableId}
      label={props.thread.title}
      variant={props.variant}
      navigationParent={props.navigationParent}
      // These rows act on their own DOM at once: the route reveal scrolls, rename focuses its
      // input, folded children feed the drag projection their height, and sweeps paint badges.
      eager={
        props.isActive ||
        props.isRenaming ||
        props.launchGroup !== undefined ||
        props.openSubagent !== null ||
        props.dropVerb !== null ||
        props.sweepAction !== null
      }
    >
      <SortableThreadRow {...props} />
    </SidebarLazyRow>
  );
}
