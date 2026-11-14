// @effect-diagnostics-next-line nodeBuiltinImport:off -- cache keys are computed synchronously.
import * as NodeCrypto from "node:crypto";

export function environmentCacheKey(env: NodeJS.ProcessEnv): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(Object.entries(env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
    .digest("hex");
}
