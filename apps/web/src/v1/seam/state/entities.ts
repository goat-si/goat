// Seam for v1 apps/web/src/state/entities.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. The provider screens read
// projects (ACP custom-model editor) and thread shells (which threads a provider change would stop). GOAT 2 has no
// v1 projects, and P2-M does not wire thread shells: both lists are empty.
import type { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";

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
