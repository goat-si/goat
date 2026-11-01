import {
  BearerConnectionCredential,
  ConnectionTransientError,
} from "@goat/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@goat/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DesktopBridge } from "@goat/contracts";

import { makeDesktopCatalogBackend } from "./storage";

const json = Schema.fromJsonString(ConnectionCatalogDocument);
const decode = Schema.decodeUnknownEffect(json);
const encode = Schema.encodeEffect(json);
const storeError = () =>
  new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: "Could not read or invalidate the secure SSH pairing grant.",
  });

/** Grants share the bearer credential's encrypted storage and lifetime; never use the browser backend. */
export function desktopSshPairingGrantStore(bridge: DesktopBridge) {
  const backend = makeDesktopCatalogBackend(bridge);
  if (backend === undefined || backend.compareAndSet === undefined) return undefined;
  const compareAndSet = backend.compareAndSet;
  const read = Effect.gen(function* () {
    const raw = yield* backend.read;
    const document =
      raw === null
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* decode(raw).pipe(Effect.mapError(storeError));
    return { raw, document };
  });

  return {
    load: Effect.fn("web.sshPairingGrantStore.load")(function* (
      connectionId: string,
      token: string,
      key: string | undefined,
    ) {
      const { document } = yield* read;
      const credential = document.credentials.find(
        (value) => value.connectionId === connectionId,
      )?.credential;
      const observed = credential?.token === token ? credential.sshPairingGrant : undefined;
      const invalidate = Effect.gen(function* () {
        if (observed === undefined) return;
        for (let attempt = 0; attempt < 5; attempt++) {
          const current = yield* read;
          const stored = current.document.credentials.find(
            (value) => value.connectionId === connectionId,
          );
          // A late rejection of an old token must not clear a new pairing, nor recreate a forgotten host.
          const currentGrant = stored?.credential.sshPairingGrant;
          if (
            stored?.credential.token !== token ||
            currentGrant?.key !== observed.key ||
            currentGrant.scopes.length !== observed.scopes.length ||
            !currentGrant.scopes.every((scope, index) => scope === observed.scopes[index])
          )
            return;
          const next = {
            ...current.document,
            credentials: current.document.credentials.map((value) =>
              value === stored
                ? { ...value, credential: new BearerConnectionCredential({ token }) }
                : value,
            ),
          };
          if (
            yield* compareAndSet(yield* encode(next).pipe(Effect.mapError(storeError)), current.raw)
          )
            return;
        }
        return yield* storeError();
      });
      if (observed !== undefined && observed.key !== key) yield* invalidate;
      return { grant: observed?.key === key ? observed : undefined, invalidate };
    }),
  };
}
