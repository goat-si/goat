import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { HubProxyConnectionProfile } from "./catalog.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type PreparedHttpAuthorization,
} from "./model.ts";
import { ConnectionProfileStore } from "./profileStore.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import { credentialConnectionId } from "./routes.ts";
import { PrimaryConnectionEndpoint } from "../platform/capabilities.ts";

export interface HubProxyAuthorization {
  readonly httpBaseUrl: string;
  readonly authorization: PreparedHttpAuthorization | null;
  readonly signer?: ManagedRelayDpopSigner["Service"];
  readonly current?: (
    rejectedAccessToken?: string,
  ) => Effect.Effect<HubProxyAuthorization, ConnectionAttemptError>;
}

export class HubProxyAuthSource extends Context.Service<
  HubProxyAuthSource,
  {
    readonly resolve: (
      profile: HubProxyConnectionProfile,
    ) => Effect.Effect<HubProxyAuthorization, ConnectionAttemptError>;
  }
>()("@goat/client-runtime/connection/hubProxyAuthSource") {}

export const make = Effect.gen(function* () {
  const profiles = yield* ConnectionProfileStore;
  const managed = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const credentials = yield* ConnectionCredentialStore;
  const primary = yield* Effect.serviceOption(PrimaryConnectionEndpoint);
  const resolve = Effect.fn("HubProxyAuthSource.resolve")(function* (
    profile: HubProxyConnectionProfile,
  ) {
    if (profile.hubConnectionId === "primary") {
      if (Option.isNone(primary))
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The hub's primary connection endpoint is unavailable.",
        });
      const endpoint = yield* primary.value.endpoint;
      return {
        httpBaseUrl: endpoint.httpBaseUrl,
        authorization: Option.match(endpoint.bearerToken, {
          onNone: () => null,
          onSome: (token) => ({ _tag: "Bearer" as const, token }),
        }),
      };
    }
    const hub = yield* profiles.get(profile.hubConnectionId);
    const relay = profile.hubConnectionId === "relay";
    if (
      !relay &&
      (Option.isNone(hub) ||
        hub.value._tag !== "BearerConnectionProfile" ||
        hub.value.environmentId !== profile.hubEnvironmentId)
    )
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `The hub connection profile ${profile.hubConnectionId} is unavailable or is not a paired address.`,
      });
    const hubProfile =
      !relay && Option.isSome(hub) && hub.value._tag === "BearerConnectionProfile"
        ? hub.value
        : undefined;
    if (relay || hubProfile?.authorization === "t3-connect") {
      if (Option.isNone(managed) || Option.isNone(signer))
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "GOAT Connect authorization is unavailable.",
        });
      const remote = managed.value;
      const dpopSigner = signer.value;
      const current = Effect.fn("HubProxyAuthSource.current")(function* (
        rejectedAccessToken?: string,
      ): Effect.fn.Return<HubProxyAuthorization, ConnectionAttemptError> {
        const directEndpoint =
          hubProfile !== undefined ? { httpBaseUrl: hubProfile.httpBaseUrl } : undefined;
        const authorized = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: profile.hubEnvironmentId,
          ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
          ...(directEndpoint === undefined ? {} : { directEndpoint }),
        });
        return {
          httpBaseUrl: authorized.httpBaseUrl,
          authorization: {
            ...authorized.httpAuthorization,
            hubProxyOwner: {
              environmentId: profile.hubEnvironmentId,
              nodeId: profile.nodeId,
              httpBaseUrl: authorized.httpBaseUrl,
              endpointMode: directEndpoint === undefined ? "managed" : "direct",
            },
          },
          signer: dpopSigner,
          current,
        };
      });
      return yield* current();
    }
    if (hubProfile === undefined)
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "The hub connection is unavailable.",
      });
    const credential = yield* credentials.get(credentialConnectionId(profile.hubConnectionId));
    if (Option.isNone(credential))
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: `The hub credential ${profile.hubConnectionId} is unavailable. Pair with the hub again.`,
      });
    return {
      httpBaseUrl: hubProfile.httpBaseUrl,
      authorization: { _tag: "Bearer" as const, token: credential.value.token },
    };
  });
  return HubProxyAuthSource.of({ resolve });
});

export const layer = Layer.effect(HubProxyAuthSource, make);
