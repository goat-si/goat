// @effect-diagnostics nodeBuiltinImport:off -- the hash is computed synchronously at each check.
import * as NodeCrypto from "node:crypto";

/** An identity of the host environment, for cache keys: a hash that holds none of its values. */
export const hostEnvironmentHash = (env: NodeJS.ProcessEnv): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(Object.entries(env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
    .digest("hex");
