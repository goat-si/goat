// @effect-diagnostics-next-line nodeBuiltinImport:off -- Digest the ref snapshot already in memory.
import * as NodeCrypto from "node:crypto";
import type { VcsStatusResult } from "@goat/contracts";

export const statusWithRefsDigest = (status: VcsStatusResult, refs: string | null) =>
  refs === null
    ? status
    : {
        ...status,
        refsDigest: NodeCrypto.createHash("sha256").update(refs).digest("hex").slice(0, 32),
      };
