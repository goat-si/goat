import {
  isActiveThreadWork,
  type ActiveThreadWorkInput,
} from "@goat/client-runtime/state/thread-inbox";

export type SidebarProjectScopeInput = ActiveThreadWorkInput & {
  readonly environmentId: string;
  readonly projectId: string;
};

/**
 * Activity's project filter arranges finished history. Active work stays listed under any
 * filter, from every connected machine, whether or not this client registered its project.
 */
export function isInSidebarProjectScope(
  thread: SidebarProjectScopeInput,
  scopedProjectKeys: ReadonlySet<string> | null,
): boolean {
  return (
    scopedProjectKeys === null ||
    scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
    isActiveThreadWork(thread)
  );
}
