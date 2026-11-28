// Seam for v1 apps/web/src/sidebarProjectGrouping.ts (goat 916b5ccc1b2): settings scope needs only the project snapshot types, not v1's project store.
import type { ScopedProjectRef } from '@goat/contracts';
import type { Project } from '../types';
export type EnvironmentPresence = 'local-only' | 'remote-only' | 'mixed';
export interface SidebarProjectGroupMember extends Project { physicalProjectKey: string; environmentLabel: string | null; }
export interface SidebarProjectSnapshot extends Project {
  projectKey: string; displayName: string; groupedProjectCount: number; environmentPresence: EnvironmentPresence;
  allRemoteMembersAreDesktopLocal: boolean; allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[]; memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[]; pinned: boolean; archived: boolean;
}
