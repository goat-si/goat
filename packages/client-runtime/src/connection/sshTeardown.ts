import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { SshEnvironmentGateway } from "../platform/capabilities.ts";
import {
  SshConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { connectionRouteId, connectionRoutes } from "./routes.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);
export function makeSshTeardown(deps: {
  ssh: SshEnvironmentGateway["Service"];
  scope: Scope.Scope;
  routeWanted: (id: EnvironmentId, routeId: string) => Effect.Effect<boolean>;
}) {
  const disconnectSsh = (environmentId: EnvironmentId, profile: SshConnectionProfile) =>
    deps.ssh.disconnect(profile.target).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not disconnect the managed SSH environment.", {
          environmentId,
          error,
        }),
      ),
      Effect.ignore,
    );

  // Teardown may block on SSH; coalesce retries without holding a lease lock.
  const sshTeardowns = new Map<string, { again: boolean }>();
  const forkSshDisconnect = (environmentId: EnvironmentId, route: ConnectionRoute) => {
    const profile = Option.getOrNull(route.profile);
    if (profile === null || !isSshConnectionProfile(profile)) return Effect.void;
    const routeId = connectionRouteId(route.target);
    const key = `${environmentId}\u0000${routeId}`;
    return Effect.suspend(() => {
      const inFlight = sshTeardowns.get(key);
      if (inFlight !== undefined) {
        inFlight.again = true;
        return Effect.void;
      }
      const teardown = { again: false };
      sshTeardowns.set(key, teardown);
      const run: Effect.Effect<void> = disconnectSsh(environmentId, profile).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (!teardown.again) return Effect.void;
            teardown.again = false;
            return deps
              .routeWanted(environmentId, routeId)
              .pipe(Effect.flatMap((wanted) => (wanted ? Effect.void : run)));
          }),
        ),
      );
      return run.pipe(
        Effect.ensuring(Effect.sync(() => sshTeardowns.delete(key))),
        Effect.forkIn(deps.scope, { startImmediately: true }),
        Effect.asVoid,
      );
    });
  };
  const forkSshTeardown = (entry: ConnectionCatalogEntry) =>
    Effect.forEach(
      connectionRoutes(entry),
      (route) => forkSshDisconnect(entry.target.environmentId, route),
      { discard: true },
    );

  return { forkSshDisconnect, forkSshTeardown };
}
