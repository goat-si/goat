import { scopedThreadKey } from "@goat/client-runtime/environment";
import { useMatches } from "@tanstack/react-router";
import { useState } from "react";

import {
  getAppModalReturnThreadTarget,
  isAppModalPage,
} from "../components/sidebar/mainAppLocation";
import type { ThreadRouteTarget } from "../threadRoutes";
import { useThreadRouteTarget } from "./useThreadRouteTarget";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

/** Usage renders over the thread that opened it; that thread stays the shown one. */
export function useShownThreadRouteTarget() {
  const routeTarget = useThreadRouteTarget();
  // Read matches so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const [backgroundTarget, setBackgroundTarget] = useState(() =>
    modalOpen ? getAppModalReturnThreadTarget() : routeTarget,
  );
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(routeTarget)) {
    setBackgroundTarget(routeTarget);
  }
  return { shownTarget: modalOpen ? backgroundTarget : routeTarget, modalOpen };
}
