import {
  type AuthClientPresentationMetadata,
  type DesktopPenMembersState,
  type DesktopPenPin,
  type DesktopPenRouteResult,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshPreparationProgress,
  type DesktopSshAttemptContext,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ConnectionAttemptError } from "../connection/model.ts";
import type { AuthorizedRemoteEnvironment } from "../authorization/service.ts";
import type { VerifiedSshEndpoint } from "../environment/descriptor.ts";
import type { SshPairingGrant } from "../connection/catalog.ts";
import { PEN_VIEWER_ENABLED } from "../connection/penViewerGate.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
  readonly verifiedEndpoint?: VerifiedSshEndpoint;
  readonly authorization?: AuthorizedRemoteEnvironment;
  readonly sshPairingGrant?: SshPairingGrant;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Stable for one signed-in session, including same-account token refreshes. */
export interface CloudSessionIdentity {
  readonly accountId: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly identity: Effect.Effect<Option.Option<CloudSessionIdentity>>;
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@goat/client-runtime/platform/capabilities/CloudSession") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@goat/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

/**
 * A random id this client keeps across launches. Environments it connects to
 * record its hash, so two environments opened from one device share an owner
 * in analytics even when nobody is signed in.
 */
export class AnalyticsDevice extends Context.Reference<{
  readonly id: Effect.Effect<Option.Option<string>>;
}>("@goat/client-runtime/platform/capabilities/AnalyticsDevice", {
  defaultValue: () => ({ id: Effect.succeedNone }),
}) {}

export type PenMembersInput = { readonly kind: "disabled" } | DesktopPenMembersState;
export class PenViewerPolicy extends Context.Reference<{ readonly enabled: boolean }>(
  "@goat/client-runtime/platform/capabilities/PenViewerPolicy",
  { defaultValue: () => ({ enabled: PEN_VIEWER_ENABLED }) },
) {}
export class PenRouteGateway extends Context.Reference<
  Option.Option<{
    readonly open: (
      pin: DesktopPenPin,
    ) => Effect.Effect<DesktopPenRouteResult, ConnectionAttemptError>;
    readonly close: (pin: DesktopPenPin) => Effect.Effect<void, ConnectionAttemptError>;
  }>
>("@goat/client-runtime/platform/capabilities/PenRouteGateway", {
  defaultValue: () => Option.none(),
}) {}
export class PenMembersGateway extends Context.Reference<{
  readonly desktop: Stream.Stream<DesktopPenMembersState>;
  readonly enabled: Stream.Stream<boolean>;
}>("@goat/client-runtime/platform/capabilities/PenMembersGateway", {
  defaultValue: () => ({ desktop: Stream.never, enabled: Stream.succeed(false) }),
}) {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
  }
>()("@goat/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@goat/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    /**
     * With `expectedEnvironmentId`, a server that is a different machine fails
     * before its one-time pairing credential is spent.
     */
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
      expectedEnvironmentId?: EnvironmentId,
      options?: {
        readonly keyOnly?: boolean;
        readonly installation?: "existing-only";
        readonly penNodeId?: string;
        readonly connectionId?: string;
        readonly onPreparationProgress?: (
          progress: DesktopSshPreparationProgress,
        ) => Effect.Effect<void>;
      },
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    /**
     * Starts or reuses the remote server for a saved connection. Returns
     * `bearerToken`, the token this client saved from an earlier pairing, while
     * the host still accepts it with the standard scopes, and pairs again only
     * when it does not, so a reconnect adds no session on the host.
     */
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly installation?: "existing-only";
      readonly penNodeId?: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
      readonly bearerToken?: string;
      readonly onHostAnswered?: Effect.Effect<void>;
      readonly onPreparationProgress?: (
        progress: DesktopSshPreparationProgress,
      ) => Effect.Effect<void>;
      readonly attemptContext?: DesktopSshAttemptContext;
      /** Runs beside saved-session validation; its result is used only if that session is accepted. */
      readonly authorize?: (
        prepared: PreparedSshEnvironment,
        onEndpointVerified: (descriptor: ExecutionEnvironmentDescriptor) => Effect.Effect<void>,
      ) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@goat/client-runtime/platform/capabilities/SshEnvironmentGateway") {}

export class PrimaryConnectionEndpoint extends Context.Service<
  PrimaryConnectionEndpoint,
  {
    readonly endpoint: Effect.Effect<
      {
        readonly httpBaseUrl: string;
        readonly bearerToken: Option.Option<string>;
      },
      ConnectionAttemptError
    >;
  }
>()("@goat/client-runtime/platform/capabilities/PrimaryConnectionEndpoint") {}
