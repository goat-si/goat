import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayHookBaseUrl, ScheduledTaskWebhookOrigin } from "./ScheduledTaskService.ts";

export const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return Effect.gen(function* () {
      if (!isGoatConnectEnabled())
        return { relayHookBaseUrl: null, unavailableReason: "relay_not_linked" as const };
      const secretsRead = yield* Effect.all([
        secrets.get(RELAY_URL_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ]).pipe(Effect.option);
      // A failed read says nothing about the link, so it reports no reason.
      if (Option.isNone(secretsRead)) return { relayHookBaseUrl: null };
      const [relayUrl, tunnelConfig] = secretsRead.value;
      if (Option.isNone(relayUrl)) {
        return { relayHookBaseUrl: null, unavailableReason: "relay_not_linked" as const };
      }
      if (Option.isNone(tunnelConfig)) {
        return {
          relayHookBaseUrl: null,
          unavailableReason: "managed_tunnel_not_configured" as const,
        };
      }
      const config = decodeRuntimeConfig(new TextDecoder().decode(tunnelConfig.value));
      const base = relayHookBaseUrl({
        relayUrl: new TextDecoder().decode(relayUrl.value),
        tunnelName: Option.isSome(config) ? config.value.tunnelName : undefined,
      });
      return base === null
        ? { relayHookBaseUrl: null, unavailableReason: "managed_tunnel_unrecognized" as const }
        : { relayHookBaseUrl: base };
    });
  }),
);
