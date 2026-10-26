import {
  ConnectionAddedBy,
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
} from "@goat/contracts";
import { LEGACY_CONNECT_ROUTE_KIND } from "@goat/contracts/legacyT3Names";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  HubProxyConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    learned: Schema.optionalKey(Schema.Literal(true)),
    authorization: Schema.optionalKey(Schema.Literal(LEGACY_CONNECT_ROUTE_KIND)),
    /**
     * "tailscale" on a learned route the server found on its Tailscale
     * interface. A bare 100.64.0.0/10 address could belong to any VPN.
     */
    network: Schema.optionalKey(Schema.Literal("tailscale")),
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
    // Older builds drop attribution when they rewrite the catalog.
    addedBy: Schema.optionalKey(ConnectionAddedBy),
  },
) {}

export class HubProxyConnectionProfile extends Schema.TaggedClass<HubProxyConnectionProfile>()(
  "HubProxyConnectionProfile",
  {
    ...ConnectionProfileBase,
    hubEnvironmentId: EnvironmentId,
    hubConnectionId: Schema.String,
    nodeId: Schema.String,
    hubLabel: Schema.optionalKey(Schema.String),
  },
) {}

export const ConnectionProfile = Schema.Union([
  BearerConnectionProfile,
  SshConnectionProfile,
  HubProxyConnectionProfile,
]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly alternateRoutes?: ReadonlyArray<ConnectionRoute>;
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
  readonly serverUpdateRequired?: boolean;
}

export const SshPairingGrant = Schema.Struct({
  key: Schema.String,
  scopes: Schema.Array(Schema.String),
});
export type SshPairingGrant = typeof SshPairingGrant.Type;

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
    sshPairingGrant: Schema.optionalKey(SshPairingGrant),
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
    /** The token from pairing over SSH, which later connects reuse. */
    credential: BearerConnectionCredential,
  },
) {}

export class HubProxyConnectionRegistration extends Schema.TaggedClass<HubProxyConnectionRegistration>()(
  "HubProxyConnectionRegistration",
  { target: HubProxyConnectionTarget, profile: HubProxyConnectionProfile },
) {}

export const ConnectionRegistration = Schema.Union([
  HubProxyConnectionRegistration,
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * The primary stays on same-origin cookie auth
 * (`PrimaryConnectionRegistration`); secondary local backends live on a
 * separate loopback origin and authenticate with a bearer token minted from
 * their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
    case "HubProxyConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}
