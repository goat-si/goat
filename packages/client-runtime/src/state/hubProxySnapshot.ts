import type { HubProxyConnectionProfile } from "../connection/catalog.ts";
import { HubProxySnapshot } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { HubProxyAuthSource } from "../connection/hubProxyAuthSource.ts";
import { hubProxyHttpBaseUrl, requestHubProxyJson } from "../connection/hubProxyHttp.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { connectionRoutes } from "../connection/routes.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { OrchestrationV2ShellSnapshot } from "@goat/contracts";

const decodeHubSnapshot = Schema.decodeUnknownEffect(Schema.toCodecJson(HubProxySnapshot));

export const hydrateHubProxySnapshot = Effect.fn("hydrateHubProxySnapshot")(function* (
  profile: HubProxyConnectionProfile,
  hydrate: (snapshot: OrchestrationV2ShellSnapshot, capturedAt: string) => Effect.Effect<boolean>,
) {
  const auth = yield* HubProxyAuthSource;
  const authorization = yield* auth.resolve(profile);
  const base = hubProxyHttpBaseUrl(authorization.httpBaseUrl, profile.nodeId);
  const snapshot = yield* requestHubProxyJson(
    authorization,
    environmentEndpointUrl(base, "/snapshot"),
    decodeHubSnapshot,
  );
  return snapshot.nodeId === profile.nodeId
    ? yield* hydrate(snapshot.shell, snapshot.capturedAt)
    : false;
});

export const watchHubProxySnapshot = Effect.fn("watchHubProxySnapshot")(function* (
  hydrate: (snapshot: OrchestrationV2ShellSnapshot, capturedAt: string) => Effect.Effect<boolean>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const registry = yield* Effect.serviceOption(EnvironmentRegistry);
  const auth = yield* Effect.serviceOption(HubProxyAuthSource);
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(registry) || Option.isNone(auth) || Option.isNone(client)) return;
  const registryService = registry.value;
  const authService = auth.value;
  const environmentId = supervisor.target.environmentId;
  yield* SubscriptionRef.changes(registryService.entries).pipe(
    Stream.switchMap((entries) => {
      const entry = entries.get(environmentId);
      const profiles =
        entry === undefined
          ? []
          : connectionRoutes(entry).flatMap((route) => {
              const profile = Option.getOrNull(route.profile);
              return profile?._tag === "HubProxyConnectionProfile" ? [profile] : [];
            });
      return Stream.mergeAll(
        [
          SubscriptionRef.changes(supervisor.state).pipe(Stream.map(() => undefined)),
          ...[...new Set(profiles.map((profile) => profile.hubEnvironmentId))].map((hubId) =>
            registryService.stateChanges(hubId).pipe(
              Stream.map(() => undefined),
              Stream.catch(() => Stream.empty),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.switchMap(() =>
          Stream.fromEffect(
            Effect.gen(function* () {
              if ((yield* SubscriptionRef.get(supervisor.state)).phase === "connected") return;
              for (const profile of profiles) {
                const hub = yield* registryService
                  .state(profile.hubEnvironmentId)
                  .pipe(Effect.option);
                if (Option.isNone(hub) || hub.value.phase !== "connected") continue;
                yield* hydrateHubProxySnapshot(profile, hydrate).pipe(
                  Effect.provideService(HubProxyAuthSource, authService),
                );
                return;
              }
            }).pipe(
              Effect.catch((error) =>
                Effect.logDebug("Could not hydrate the hub's cached node snapshot.", { error }),
              ),
            ),
          ),
        ),
      );
    }),
    Stream.runDrain,
    Effect.provideService(HttpClient.HttpClient, client.value),
  );
});
