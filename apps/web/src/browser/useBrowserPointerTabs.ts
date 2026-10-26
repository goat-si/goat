import { useEffect, useRef } from "react";

import { useBrowserPointerStore } from "./browserPointerStore";

/** Tombstones the pointer of a hosted tab that closed, and reattaches one that comes back. */
export function useBrowserPointerTabs(hostedTabIds: string) {
  const pointerTabs = useRef<Set<string>>(new Set());
  // oxlint-disable-next-line goat/react-effect-budget -- syncs the external pointer store with the hosted tab set after commit.
  useEffect(() => {
    const active = new Set(hostedTabIds.split("\n").filter(Boolean));
    const store = useBrowserPointerStore.getState();
    for (const tabId of pointerTabs.current) if (!active.has(tabId)) store.detach(tabId);
    for (const tabId of active) if (!pointerTabs.current.has(tabId)) store.attach(tabId);
    pointerTabs.current = active;
  }, [hostedTabIds]);
}
