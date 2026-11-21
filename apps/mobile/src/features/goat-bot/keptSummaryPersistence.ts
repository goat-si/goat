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
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { runtime } from "../../lib/runtime";
import {
  botSummaryCloudAccountKey,
  botSummaryGlobalPurgeKey,
  botSummaryLocalId,
  botSummaryPurgeKey,
  MobileDatabase,
} from "../../persistence/mobile-database";
import { secureStore } from "../../persistence/namespaced-secure-store";
import { environmentSession } from "../../state/session";
import { createKeptSummaryStore, type KeptKind } from "./keptSummaryStore";

// Separate projection keys keep the shared cache readable by older mobile clients.
const cacheKind = "shell";
const summaryKey = (kind: KeptKind, scope: string) => `goat-bot-summary:${kind}:${scope}`;
const database = <A>(use: (db: MobileDatabase["Service"]) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(MobileDatabase, use));
const invalidationKey = (id: EnvironmentId | null) =>
  id === null
    ? botSummaryGlobalPurgeKey
    : `${botSummaryPurgeKey}.${Array.from(new TextEncoder().encode(id), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;

const openStore = () =>
  createKeptSummaryStore(
    {
      read: (id, kind, scope) =>
        database((db) =>
          Effect.map(db.loadCache(id, cacheKind, summaryKey(kind, scope)), Option.getOrNull),
        ),
      write: (id, kind, payload, scope) =>
        database((db) => db.saveCache(id, cacheKind, summaryKey(kind, scope), 2, payload)),
      remove: (id, kind, scope) =>
        database((db) => db.removeCache(id, cacheKind, summaryKey(kind, scope))),
      markPurge: (id) =>
        database((db) =>
          db.saveCache(
            id ?? botSummaryLocalId,
            cacheKind,
            id === null ? botSummaryGlobalPurgeKey : botSummaryPurgeKey,
            1,
            "null",
          ),
        ),
      deleteSummaries: (id) => database((db) => db.deleteBotSummaryCache(id)),
      sweep: (expiredBefore) => database((db) => db.sweepBotSummaryCache(expiredBefore)),
    },
    {
      mark: (id) => secureStore.setItem(invalidationKey(id), "1"),
      has: async (id) => (await secureStore.getItem(invalidationKey(id))) !== null,
      clear: (id) => secureStore.removeItem(invalidationKey(id)),
    },
  );

const accountAtom = Atom.map(managedRelaySessionAtom, (session) => session?.accountId ?? null);
const fingerprint = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

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
    const pairingFingerprint = (kind: string, secret: string) =>
      Effect.promise(() => fingerprint(JSON.stringify([input.id, kind, secret])));

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
        return [yield* pairingFingerprint("bearer", auth.token)];
      if (auth?._tag !== "Dpop" || !hasRelayRoute || !relayAccount) return [];
      const tokens = yield* TokenStore.RemoteDpopAccessTokenStore;
      const token = Option.getOrNull(
        yield* tokens.get(auth.hubProxyOwner?.environmentId ?? input.id),
      );
      return token?.accountId === relayAccount && token.accessToken === auth.accessToken
        ? [yield* pairingFingerprint("relay", relayAccount)]
        : [];
    }
    const scopes = yield* Effect.forEach(secrets, (secret) => pairingFingerprint("bearer", secret));
    if (hasRelayRoute && relayAccount)
      scopes.push(yield* pairingFingerprint("relay", relayAccount));
    return scopes;
  }),
});

export function createMobileKeptSummaryPersistence() {
  const store = openStore();
  let accountLoad: Promise<string | null> | undefined;
  let accountWork = Promise.resolve();
  let failedAccount: { readonly id: string | null } | undefined;

  const readAccount = () =>
    (accountLoad ??= database((db) =>
      Effect.map(
        db.loadCache(botSummaryLocalId, cacheKind, botSummaryCloudAccountKey),
        Option.getOrNull,
      ),
    ).catch((error: unknown) => {
      accountLoad = undefined;
      throw error;
    }));
  const accountFingerprint = (id: string | null) => (id === null ? null : fingerprint(id));
  function observeAccount(id: string | null) {
    const update = async () => {
      const previous = await readAccount();
      const next = await accountFingerprint(id);
      if (next === previous) return;
      if (previous !== null) await store.purgeAll();
      await database((db) =>
        next === null
          ? db.removeCache(botSummaryLocalId, cacheKind, botSummaryCloudAccountKey)
          : db.saveCache(botSummaryLocalId, cacheKind, botSummaryCloudAccountKey, 1, next),
      );
      accountLoad = Promise.resolve(next);
    };
    failedAccount = undefined;
    const work = accountWork.then(update, update);
    accountWork = work;
    void work.catch(() => {
      if (accountWork === work) failedAccount = { id };
    });
    return work;
  }

  return {
    store,
    accountAtom,
    observeAccount,
    startMaintenance(onChange: () => void, onFailure: () => void) {
      const maintain = async () => {
        await store.maintain(Date.now());
        if (failedAccount !== undefined) {
          await observeAccount(failedAccount.id);
          onChange();
        }
      };
      void maintain().catch(onFailure);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void maintain().catch(onFailure);
      });
      return () => subscription.remove();
    },
    async scopes(registry: AtomRegistry.AtomRegistry, id: EnvironmentId, live: boolean) {
      const observed = accountWork;
      await observed;
      const account = registry.get(accountAtom);
      const savedAccount = await readAccount();
      // An account active in the previous process must be observed before restoring its cache.
      if (savedAccount !== (await accountFingerprint(account))) return [];
      const result = await resolveScopes.run(registry, { id, live });
      if (accountWork !== observed || registry.get(accountAtom) !== account) return [];
      if (result._tag === "Success") return result.value;
      throw new Error("Could not read the local pairing for the bot summary.");
    },
  };
}

export const mobileKeptSummaryPersistence = createMobileKeptSummaryPersistence();
