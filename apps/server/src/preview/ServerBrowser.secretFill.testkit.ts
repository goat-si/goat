// @effect-diagnostics nodeBuiltinImport:off - dummy secret values stay in scoped test fixtures.
import * as NodeCrypto from "node:crypto";
import { SecretRef, SecretRequestError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecretRequests from "../secrets/SecretRequests.ts";

/** A one-use store with the real service's origin rule; refusals leave the value in place. */
export const makeSecrets = (beforeConsume: () => Promise<unknown> = async () => {}) => {
  const saved = new Map<string, { readonly origin: string; readonly value: string }>();
  const consumed: Array<string> = [];
  const save = (origin: string, value = `pw_${NodeCrypto.randomUUID()}`) => {
    const ref = SecretRef.make(`secret-ref:${NodeCrypto.randomBytes(16).toString("hex")}`);
    saved.set(ref, { origin, value });
    return { ref, value };
  };
  const unused = () => Effect.die("unused in these tests");
  const service = SecretRequests.SecretRequests.of({
    answer: unused,
    savedRef: unused,
    consume: unused,
    saveToFile: unused,
    useLogin: unused,
    useCard: unused,
    useOneTimeCode: unused,
    consumeForOrigin: (input) =>
      Effect.promise(beforeConsume).pipe(
        Effect.andThen(() => {
          const entry = saved.get(input.ref);
          if (entry === undefined)
            return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
          if (entry.origin !== input.origin)
            return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
          saved.delete(input.ref);
          consumed.push(input.ref);
          return Effect.succeed(entry.value);
        }),
      ),
  });
  return { save, saved, consumed, layer: Layer.succeed(SecretRequests.SecretRequests, service) };
};
