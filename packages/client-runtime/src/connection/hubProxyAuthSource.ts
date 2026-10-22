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
    if (
      Option.isNone(hub) ||
      hub.value._tag !== "BearerConnectionProfile" ||
      hub.value.environmentId !== profile.hubEnvironmentId
    )
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `The hub connection profile ${profile.hubConnectionId} is unavailable or is not a paired address.`,
      });
    if (hub.value.authorization === "t3-connect")
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Hub proxy connections require a paired hub address or the web primary connection.",
      });
    const credential = yield* credentials.get(credentialConnectionId(profile.hubConnectionId));
    if (Option.isNone(credential))
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: `The hub credential ${profile.hubConnectionId} is unavailable. Pair with the hub again.`,
      });
    return {
      httpBaseUrl: hub.value.httpBaseUrl,
      authorization: { _tag: "Bearer" as const, token: credential.value.token },
    };
  });
  return HubProxyAuthSource.of({ resolve });
});

export const layer = Layer.effect(HubProxyAuthSource, make);
