import { createMigratingDatabaseOpener } from "../lib/indexedDbMigration";
import { computeDpopJwkThumbprint, DpopPublicJwk } from "@goat/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { importJWK, type JWK } from "jose";
import { DpopProof } from "@goat/client-runtime/relay";

export interface BrowserDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

export class BrowserDpopError extends Data.TaggedError("BrowserDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DPOP_DATABASE_NAME = "goat:cloud-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "relay-dpop-proof-key";
const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

export const layer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

function dpopError(message: string, cause?: unknown) {
  return new BrowserDpopError({ message, ...(cause === undefined ? {} : { cause }) });
}

const openMigratedDpopDatabase = createMigratingDatabaseOpener(
  DPOP_DATABASE_NAME,
  DPOP_DATABASE_VERSION,
  (database) => {
    if (!database.objectStoreNames.contains(DPOP_KEY_STORE_NAME))
      database.createObjectStore(DPOP_KEY_STORE_NAME);
  },
);
function openDpopDatabase(): Effect.Effect<IDBDatabase, BrowserDpopError> {
  return Effect.tryPromise({
    try: openMigratedDpopDatabase,
    catch: (cause) => dpopError("Could not open DPoP key storage.", cause),
  });
}

export function readStoredBrowserDpopKey(): Effect.Effect<BrowserDpopKey | null, BrowserDpopError> {
  if (typeof indexedDB === "undefined") {
    return Effect.succeed(null);
  }
  return Effect.acquireUseRelease(
    openDpopDatabase(),
    (database) =>
      Effect.callback<BrowserDpopKey | null, BrowserDpopError>((resume) => {
        const request = database
          .transaction(DPOP_KEY_STORE_NAME, "readonly")
          .objectStore(DPOP_KEY_STORE_NAME)
          .get(DPOP_KEY_ID);
        request.addEventListener("error", () =>
          resume(Effect.fail(dpopError("Could not read DPoP key.", request.error ?? undefined))),
        );
        request.addEventListener("success", () =>
          resume(Effect.succeed((request.result as BrowserDpopKey | undefined) ?? null)),
        );
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

export function writeStoredBrowserDpopKey(
  key: BrowserDpopKey,
): Effect.Effect<void, BrowserDpopError> {
  if (typeof indexedDB === "undefined") {
    return Effect.void;
  }
  return Effect.acquireUseRelease(
    openDpopDatabase(),
    (database) =>
      Effect.callback<void, BrowserDpopError>((resume) => {
        const transaction = database.transaction(DPOP_KEY_STORE_NAME, "readwrite");
        transaction.addEventListener("error", () =>
          resume(
            Effect.fail(dpopError("Could not write DPoP key.", transaction.error ?? undefined)),
          ),
        );
        transaction.addEventListener("complete", () => resume(Effect.void));
        transaction.objectStore(DPOP_KEY_STORE_NAME).put(key, DPOP_KEY_ID);
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

export const generateBrowserDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
    catch: (cause) => dpopError("Could not generate DPoP proof key.", cause),
  });
  const privateJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.privateKey),
    catch: (cause) => dpopError("Could not export DPoP private key.", cause),
  });
  const publicJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.publicKey),
    catch: (cause) => dpopError("Could not export DPoP public key.", cause),
  }).pipe(
    Effect.flatMap((jwk) => decodeDpopPublicJwk(jwk)),
    Effect.mapError((cause) =>
      cause instanceof BrowserDpopError
        ? cause
        : dpopError("Generated DPoP public key is invalid.", cause),
    ),
  );
  const privateKey = yield* Effect.tryPromise({
    try: () => importJWK(privateJwk as JWK, "ES256", { extractable: false }) as Promise<CryptoKey>,
    catch: (cause) => dpopError("Could not import DPoP private key.", cause),
  });
  return {
    privateKey,
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
});

export const createBrowserDpopProof = Effect.fn("dpop.createBrowserDpopProof")(function* (input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey: BrowserDpopKey;
}): Effect.fn.Return<
  { readonly proof: string; readonly thumbprint: string },
  BrowserDpopError,
  Crypto.Crypto
> {
  const proof = yield* DpopProof.createProof({
    method: input.method,
    url: input.url,
    accessToken: input.accessToken,
    publicJwk: input.proofKey.publicJwk,
    error: dpopError,
    sign: (bytes) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              input.proofKey.privateKey,
              new Uint8Array(bytes),
            ),
          ),
        catch: (cause) => dpopError("Could not sign DPoP proof.", cause),
      }),
  });
  return { proof, thumbprint: input.proofKey.thumbprint };
});
