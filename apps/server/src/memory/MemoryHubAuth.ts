import * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Store from "./MemoryStore.ts";

export class MemoryHubAuth extends Context.Service<
  MemoryHubAuth,
  {
    readonly authenticate: (
      authorization: string | undefined,
    ) => Effect.Effect<M.MemoryHubPrincipal, M.MemoryHubUnauthorizedError | M.MemoryHubError>;
    readonly reauthorize: (
      principal: M.MemoryHubPrincipal,
    ) => Store.InTx<
      void,
      M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError | Store.MemoryStorageError
    >;
  }
>()("goat/memory/MemoryHubAuth") {}

const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const crypto = yield* Crypto.Crypto;
  const authenticate = Effect.fnUntraced(function* (authorization: string | undefined) {
    // A credential is exactly 32 random bytes in unpadded base64url. Never consume
    // cookie, dev-session, MCP, or ambient browser authority on this boundary.
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    if (!match) return yield* new M.MemoryHubUnauthorizedError({});
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(match[1])).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
    );
    const member = yield* store
      .findHubMemberByCredential(digest)
      .pipe(Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })));
    if (!member || member.status !== "active") return yield* new M.MemoryHubUnauthorizedError({});
    return {
      environmentId: member.environmentId,
      memorySpaceId: member.memorySpaceId,
      credentialVersion: member.credentialVersion,
      scopes: ["memory:sync"] as const,
    };
  });
  return MemoryHubAuth.of({
    authenticate,
    reauthorize: (principal) => store.requireHubMemberTx(principal).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(MemoryHubAuth, make);
