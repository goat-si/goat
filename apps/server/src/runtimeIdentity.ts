import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Identity of this server start, shared by its descriptor, runtime file, and drain CAS. */
export class RuntimeIdentity extends Context.Service<
  RuntimeIdentity,
  { readonly instanceId: string }
>()("goat/runtimeIdentity") {}

export const layer = Layer.effect(
  RuntimeIdentity,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return { instanceId: yield* crypto.randomUUIDv4() };
  }),
);
