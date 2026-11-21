import {
  connectionRoutes,
  CredentialStore,
  credentialConnectionId,
  RELAY_ROUTE_ID,
} from "@goat/client-runtime/connection";
import { TokenStore } from "@goat/client-runtime/authorization";
import { managedRelaySessionAtom } from "@goat/client-runtime/relay";
import { createRuntimeCommand } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { LEGACY_CONNECT_ROUTE_KIND } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { runtime } from "../../lib/runtime";
import { MobileDatabase } from "../../persistence/mobile-database";
import { environmentSession } from "../../state/session";
import { createKeptSummaryStore, KEPT_KINDS, type KeptKind } from "./keptSummaryStore";

// Separate projection keys keep the shared cache readable by older mobile clients.
const cacheKind = "shell";
const summaryKey = (kind: KeptKind) => `goat-bot-summary:${kind}`;
const database = <A>(use: (db: MobileDatabase["Service"]) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(MobileDatabase, use));

const store = createKeptSummaryStore({
  read: (id, kind) =>
    database((db) => Effect.map(db.loadCache(id, cacheKind, summaryKey(kind)), Option.getOrNull)),
  write: (id, kind, payload) =>
    database((db) => db.saveCache(id, cacheKind, summaryKey(kind), 1, payload)),
  remove: (id, kind) => database((db) => db.removeCache(id, cacheKind, summaryKey(kind))),
  clear: () =>
    database((db) =>
      Effect.flatMap(db.inspectCaches, (rows) =>
        Effect.forEach(
          new Set(rows.filter((row) => row.kind === cacheKind).map((row) => row.environmentId)),
          (id) =>
            Effect.forEach(KEPT_KINDS, (kind) => db.removeCache(id, cacheKind, summaryKey(kind)), {
              discard: true,
            }),
          { discard: true },
        ),
      ),
    ),
});

const resolveScopes = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile.keptBotSummary.pairingScopes",
  execute: Effect.fn("MobileKeptBotSummary.pairingScopes")(function* (
    input: { readonly id: EnvironmentId; readonly live: boolean },
    registry: AtomRegistry.AtomRegistry,
  ) {
    const entries = registry.get(environmentCatalog.catalogValueAtom).entries;
    const entry = entries.get(input.id);
    if (!entry?.enabled) return [];
    const relayAccount = registry.get(managedRelaySessionAtom)?.accountId;
    const prepared = input.live
      ? Option.getOrNull(registry.get(environmentSession.preparedConnectionValueAtom(input.id)))
      : null;
    const credentials = yield* CredentialStore.ConnectionCredentialStore;
    const fingerprint = (kind: string, secret: string) =>
      Effect.promise(() =>
        digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify([input.id, kind, secret])),
      );

    const secrets = new Set<string>();
    let hasRelayRoute = false;
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (route.target._tag === "RelayConnectionTarget") {
        hasRelayRoute = true;
        continue;
      }
      if (profile === null) continue;
      let sourceId = profile.connectionId;
      let bearer = profile._tag === "BearerConnectionProfile" ? profile : null;
      if (profile._tag === "HubProxyConnectionProfile") {
        if (profile.hubConnectionId === RELAY_ROUTE_ID) {
          hasRelayRoute = true;
          continue;
        }
        const hub = entries.get(profile.hubEnvironmentId);
        const source =
          hub &&
          connectionRoutes(hub).find(
            (candidate) =>
              Option.getOrNull(candidate.profile)?.connectionId === profile.hubConnectionId,
          );
        const hubProfile = source && Option.getOrNull(source.profile);
        if (hubProfile?._tag !== "BearerConnectionProfile") continue;
        bearer = hubProfile;
        sourceId = profile.hubConnectionId;
      }
      if (bearer?.authorization === LEGACY_CONNECT_ROUTE_KIND) {
        hasRelayRoute = true;
        continue;
      }
      const credential = yield* credentials.get(credentialConnectionId(sourceId));
      if (Option.isSome(credential)) secrets.add(credential.value.token);
    }
    if (
      registry.get(environmentCatalog.catalogValueAtom).entries.get(input.id) !== entry ||
      registry.get(managedRelaySessionAtom)?.accountId !== relayAccount
    )
      return [];
    if (input.live) {
      const current = Option.getOrNull(
        registry.get(environmentSession.preparedConnectionValueAtom(input.id)),
      );
      if (prepared !== current) return [];
      const auth = prepared?.httpAuthorization;
      if (auth?._tag === "Bearer" && secrets.has(auth.token))
        return [yield* fingerprint("bearer", auth.token)];
      if (auth?._tag !== "Dpop" || !hasRelayRoute || !relayAccount) return [];
      const tokens = yield* TokenStore.RemoteDpopAccessTokenStore;
      const token = Option.getOrNull(
        yield* tokens.get(auth.hubProxyOwner?.environmentId ?? input.id),
      );
      return token?.accountId === relayAccount && token.accessToken === auth.accessToken
        ? [yield* fingerprint("relay", relayAccount)]
        : [];
    }
    const scopes = yield* Effect.forEach(secrets, (secret) => fingerprint("bearer", secret));
    if (hasRelayRoute && relayAccount) scopes.push(yield* fingerprint("relay", relayAccount));
    return scopes;
  }),
});

export const mobileKeptSummaryPersistence = {
  store,
  async scopes(registry: AtomRegistry.AtomRegistry, id: EnvironmentId, live: boolean) {
    const result = await resolveScopes.run(registry, { id, live });
    if (result._tag === "Success") return result.value;
    throw new Error("Could not read the local pairing for the bot summary.");
  },
  accountAtom: Atom.map(managedRelaySessionAtom, (session) => session?.accountId ?? null),
};
