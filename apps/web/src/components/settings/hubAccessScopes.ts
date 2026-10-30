import { AuthHubProxyScope, type AuthEnvironmentScope } from "@goat/contracts";

/** The owner grants hub access without holding it, so the client check skips that one scope. */
export const heldOrGranted = (
  scope: AuthEnvironmentScope,
  holds: (scope: AuthEnvironmentScope) => boolean,
) => scope === AuthHubProxyScope || holds(scope);
