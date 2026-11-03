import { type ConnectionCatalogEntry, connectionRoutes } from "@goat/client-runtime/connection";
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@goat/contracts";
import type { RelayClientEnvironmentRecord } from "@goat/contracts/relay";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

type EnvironmentSectionEntry = Pick<
  ConnectedEnvironmentSummary,
  "environmentId" | "isRelayManaged"
>;

export interface EnvironmentSectionsInput<
  T extends EnvironmentSectionEntry = ConnectedEnvironmentSummary,
> {
  readonly connectedEnvironments: ReadonlyArray<T>;
  readonly cloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null;
}

export interface EnvironmentSections<
  T extends EnvironmentSectionEntry = ConnectedEnvironmentSummary,
> {
  readonly localEnvironments: ReadonlyArray<T>;
  readonly connectedCloudEnvironments: ReadonlyArray<T>;
  readonly availableCloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord>;
}

export function relayManagedEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isRelayManaged: boolean;
  }>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments
      .filter((environment) => environment.isRelayManaged)
      .map((environment) => environment.environmentId),
  );
}

export function splitEnvironmentSections<T extends EnvironmentSectionEntry>(
  input: EnvironmentSectionsInput<T>,
): EnvironmentSections<T> {
  if (!isGoatConnectEnabled()) {
    return {
      localEnvironments: input.connectedEnvironments,
      connectedCloudEnvironments: [],
      availableCloudEnvironments: [],
    };
  }
  const savedEnvironmentIds = relayManagedEnvironmentIds(input.connectedEnvironments);

  return {
    localEnvironments: input.connectedEnvironments.filter(
      (environment) => !environment.isRelayManaged,
    ),
    connectedCloudEnvironments: input.connectedEnvironments.filter(
      (environment) => environment.isRelayManaged,
    ),
    availableCloudEnvironments: (input.cloudEnvironments ?? []).filter(
      (environment) => !savedEnvironmentIds.has(environment.environmentId),
    ),
  };
}

export function isGoatConnectOnlyEnvironment(entry: ConnectionCatalogEntry | undefined): boolean {
  return (
    entry !== undefined &&
    connectionRoutes(entry).every((route) => {
      const profile = Option.getOrNull(route.profile);
      return (
        route.target._tag === "RelayConnectionTarget" ||
        (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect")
      );
    })
  );
}
