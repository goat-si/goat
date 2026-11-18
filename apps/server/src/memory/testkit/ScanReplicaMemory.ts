import type * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { MEMORY_SCANNER_POLICY_VERSION, scanMemoryValue } from "../MemorySecretScanner.ts";
import * as Store from "../MemoryStore.ts";

export const scanReplicaMemory = Effect.fn("test.scanReplicaMemory")(function* (
  memoryId: M.MemoryId,
) {
  const store = yield* Store.MemoryStore;
  const now = yield* Clock.currentTimeMillis;
  const work = (yield* store.readDeferred(now, 100)).find(
    (work) => work.memoryId === memoryId && work.kind === "scanner",
  );
  if (!work) throw new Error("Expected received scanner work");
  const chunk = yield* store.readScannerChunk(work);
  if (chunk.nextCursor !== null || scanMemoryValue({ payloads: chunk.payloads }).kind !== "allowed")
    throw new Error("Expected one clean synthetic scanner page");
  if (
    !(yield* store.finishDeferred(work, {
      now,
      scannerPolicyVersion: MEMORY_SCANNER_POLICY_VERSION,
    }))
  )
    throw new Error("Expected scanner work to settle");
});
