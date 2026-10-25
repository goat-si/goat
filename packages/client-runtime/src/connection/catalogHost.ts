import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import type {
  ConnectionCatalogOperation,
  ConnectionCatalogResult,
  DesktopSshEnvironmentTarget,
  SavedConnection,
  SavedConnectionRoute,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { connectionRoutes } from "./routes.ts";
import { isDesktopLocalConnectionTarget } from "./desktopLocal.ts";

function isPlatformEntry(entry: ConnectionCatalogEntry) {
  return connectionRoutes(entry).some(
    (route) =>
      route.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(route.target),
  );
}

function savedConnection(entry: ConnectionCatalogEntry): SavedConnection {
  const routes: SavedConnectionRoute[] = [];
  let addedBy: SavedConnection["addedBy"];
  for (const route of connectionRoutes(entry)) {
    const profile = Option.getOrNull(route.profile);
    if (profile?._tag === "SshConnectionProfile") {
      routes.push({
        kind: "ssh",
        host: profile.target.alias,
        hostname: profile.target.hostname,
        username: profile.target.username,
        port: profile.target.port,
      });
      addedBy ??= profile.addedBy;
    } else if (route.target._tag === "RelayConnectionTarget") {
      routes.push({ kind: "t3-connect" });
    } else if (profile?._tag === "BearerConnectionProfile") {
      routes.push({ kind: "direct", httpBaseUrl: profile.httpBaseUrl });
    } else if (profile?._tag === "HubProxyConnectionProfile") {
      routes.push({
        kind: "hub-proxy",
        hubEnvironmentId: profile.hubEnvironmentId,
        nodeId: profile.nodeId,
      });
    }
  }
  return {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    enabled: entry.enabled,
    routes,
    ...(addedBy === undefined ? {} : { addedBy }),
  };
}

function sameEndpoint(a: DesktopSshEnvironmentTarget, b: DesktopSshEnvironmentTarget) {
  return (
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    (a.username ?? "") === (b.username ?? "") &&
    (a.port ?? 22) === (b.port ?? 22)
  );
}

/** Runs the same catalog mutations as Settings and returns only public connection data. */
export const handleConnectionCatalogOperation = <E>(
  operation: ConnectionCatalogOperation,
  resolveSshTarget: (alias: string) => Effect.Effect<DesktopSshEnvironmentTarget, E>,
): Effect.Effect<
  ConnectionCatalogResult,
  never,
  EnvironmentRegistry.EnvironmentRegistry | ConnectionOnboarding.ConnectionOnboarding
> =>
  Effect.gen(function* (): Effect.fn.Return<
    ConnectionCatalogResult,
    | E
    | Effect.Error<ReturnType<EnvironmentRegistry.EnvironmentRegistry["Service"]["remove"]>>
    | Effect.Error<ReturnType<ConnectionOnboarding.ConnectionOnboarding["Service"]["registerSsh"]>>,
    EnvironmentRegistry.EnvironmentRegistry | ConnectionOnboarding.ConnectionOnboarding
  > {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entries = yield* SubscriptionRef.get(registry.entries);
    switch (operation.type) {
      case "list":
        return {
          type: "list",
          connections: [...entries.values()]
            .filter((entry) => !isPlatformEntry(entry))
            .map(savedConnection),
        };
      case "add_ssh": {
        const target = yield* resolveSshTarget(operation.host);
        for (const entry of entries.values()) {
          if (
            connectionRoutes(entry).some((route) => {
              const profile = Option.getOrNull(route.profile);
              return (
                profile?._tag === "SshConnectionProfile" &&
                (profile.target.alias === operation.host || sameEndpoint(profile.target, target))
              );
            })
          )
            return { type: "add_ssh", created: false, connection: savedConnection(entry) };
        }
        const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
        const environmentId = yield* onboarding.registerSsh({
          target,
          keyOnly: true,
          addedBy: operation.addedBy,
          ...(operation.label === undefined ? {} : { label: operation.label }),
        });
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        if (entry === undefined)
          return {
            type: "failure",
            reason: "connection_failed",
            message: "The SSH connection was not saved.",
          };
        if (isPlatformEntry(entry))
          return {
            type: "failure",
            reason: "refused",
            message: `${operation.host} reaches this machine's own environment; it is already in the sidebar.`,
          };
        return {
          type: "add_ssh",
          created: !entries.has(environmentId),
          connection: savedConnection(entry),
        };
      }
      case "remove": {
        const entry = entries.get(operation.environmentId);
        if (entry === undefined)
          return {
            type: "failure",
            reason: "not_found",
            message: "That saved connection does not exist.",
          };
        if (isPlatformEntry(entry))
          return {
            type: "failure",
            reason: "refused",
            message: "Platform-managed local environments cannot be removed.",
          };
        if (
          isGoatConnectEnabled() &&
          connectionRoutes(entry).some((route) => route.target._tag === "RelayConnectionTarget")
        )
          return {
            type: "failure",
            reason: "refused",
            message: "Use Settings → Connections to manage GOAT Connect environments.",
          };
        const removed = savedConnection(entry);
        yield* registry.remove(operation.environmentId);
        return { type: "remove", removed };
      }
    }
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method '[^']+':\s*/u, "")
        .replace(/^[A-Za-z][A-Za-z0-9]*Error:\s*/u, "")
        .trim();
      return Effect.succeed({
        type: "failure" as const,
        reason: "connection_failed" as const,
        message: message.slice(0, 2000),
      });
    }),
  );
