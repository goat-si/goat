// Seam for v1 apps/web/src/state/entities.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. The provider screens read
// projects (ACP custom-model editor) and thread shells (which threads a provider change would stop). GOAT 2 has no
// v1 projects, and P2-M does not wire thread shells: both lists are empty.
// Lane F: the timeline uses useThreadShell only to title and link a "read thread" row; with no v1 shell for other
// threads it returns null and the row shows its unlinked label (v1's own fallback). Planned: GOAT 2 thread cards.
import type { EnvironmentId, ProjectId, ProviderInstanceId, ScopedThreadRef, ThreadId } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";

export interface Goat2ProjectShell {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface Goat2ThreadShell {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtime: { readonly activeRunId: string | null } | null;
}

export function useProjects(): ReadonlyArray<Goat2ProjectShell> {
  return [];
}

export function useThreadShells(): ReadonlyArray<Goat2ThreadShell> {
  return [];
}

export function useThreadShell(_ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return null;
}
