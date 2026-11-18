// @effect-diagnostics nodeBuiltinImport:off - the read key is compared by its sha256, as launch stores it.
import * as NodeCrypto from "node:crypto";
import { OrchestratorMcpFailure, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { unavailable } from "../mcp/threadAccess.ts";

const notBound = () =>
  new OrchestratorMcpFailure({
    code: "thread_not_found",
    classification: "not_bound",
    message: "This read key is not bound to that thread.",
  });

const keysMatch = (supplied: Buffer, storedHex: string) => {
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === supplied.length && NodeCrypto.timingSafeEqual(supplied, stored);
};

/** The origin label of the binding, when this read key binds the correlation to that thread. */
export const boundOriginLabel = Effect.fn("remoteReports.boundOriginLabel")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly correlationId: string; readonly readKey: string; readonly threadId: ThreadId },
) {
  const rows = yield* sql<{
    readonly threadId: ThreadId;
    readonly readKeyHash: string;
    readonly originLabel: string;
  }>`
    SELECT thread_id AS "threadId", read_key_hash AS "readKeyHash", origin_label AS "originLabel"
    FROM remote_report_bindings
    WHERE correlation_id = ${input.correlationId}
  `.pipe(Effect.mapError(unavailable));
  const binding = rows[0];
  const supplied = NodeCrypto.createHash("sha256").update(input.readKey, "utf8").digest();
  if (
    binding === undefined ||
    !keysMatch(supplied, binding.readKeyHash) ||
    binding.threadId !== input.threadId
  )
    return yield* notBound();
  return binding.originLabel;
});
