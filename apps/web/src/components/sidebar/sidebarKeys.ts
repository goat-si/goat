import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";

export function scrollSidebarToTop(content: HTMLElement | null) {
  content?.closest("[data-slot=scroll-area-viewport]")?.scrollTo({ top: 0 });
}

export function threadShellKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}
