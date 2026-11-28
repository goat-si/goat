// GOAT 2 runs one local host per app (docs/lanes/PART1.md fixed decisions), so the lifted v1 screens see exactly one
// environment: this machine, whose owner holds every scope.
import { AuthEnvironmentScope, EnvironmentId, type SessionGrantInput } from "@goat/contracts";

export const GOAT2_ENVIRONMENT_ID = EnvironmentId.make("goat2-local");
export const GOAT2_ENVIRONMENT_LABEL = "This Mac";

export const GOAT2_OWNER_SESSION: SessionGrantInput = {
  authenticated: true,
  scopes: AuthEnvironmentScope.literals,
};
