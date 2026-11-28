// Seam for v1 apps/web/src/state/session.ts (goat 916b5ccc1b2): session grants for the one GOAT 2 environment.
import { type AuthEnvironmentScope, type EnvironmentId, sessionGrantsScope } from "@goat/contracts";

import { GOAT2_ENVIRONMENT_ID, GOAT2_OWNER_SESSION } from "../goat2/environment";

function grants(environmentId: EnvironmentId | null, scope: AuthEnvironmentScope): boolean {
  return environmentId === GOAT2_ENVIRONMENT_ID && sessionGrantsScope(GOAT2_OWNER_SESSION, scope);
}

export function useEnvironmentScope(environmentId: EnvironmentId | null, scope: AuthEnvironmentScope): boolean {
  return grants(environmentId, scope);
}

export function readEnvironmentScope(environmentId: EnvironmentId, scope: AuthEnvironmentScope): boolean {
  return grants(environmentId, scope);
}

export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  return new Set(environments.map((e) => e.environmentId).filter((id) => grants(id, scope)));
}

export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  return {
    data: environmentId === GOAT2_ENVIRONMENT_ID ? GOAT2_OWNER_SESSION : null,
    hasError: false,
    isPending: false,
  };
}
