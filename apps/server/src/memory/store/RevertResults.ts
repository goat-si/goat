import * as M from "@goat/contracts";
import { revertSlotFromReceipt } from "../MemoryRevertSlot.ts";
import * as Effect from "effect/Effect";
import { revertSlotCodec, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { Transaction, strict } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeRevertResults = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  const recordRevertResultTx: MemoryStoreShape["recordRevertResultTx"] = Effect.fn(
    "MemoryStore.recordRevertResultTx",
  )(function* (input) {
    yield* Transaction;
    // Compare and swap the observed slot. An older refusal cannot settle a newer
    // attempt. Any authoritative acceptance wins, then stays sticky forever.
    const rows = yield* stored(
      "revert-slot-read",
      sql<{ revert_operation_id: string | null; revert_result_json: string | null }>`
      SELECT revert_operation_id,revert_result_json FROM memory_resolutions WHERE space=${input.space} AND memory_id=${input.memoryId} AND resolution_id=${input.resolutionId}`,
    );
    const old = rows[0];
    if (!old) return;
    const previous = old.revert_result_json
      ? yield* revertSlotCodec.decode(old.revert_result_json, strict)
      : undefined;
    if (
      previous?.status === "accepted" ||
      (input.settlement &&
        input.slot.status !== "accepted" &&
        old.revert_operation_id !== input.operationId)
    )
      return;
    yield* stored(
      "revert-slot-cas",
      sql`UPDATE memory_resolutions SET revert_operation_id=${input.operationId},revert_result_json=${yield* revertSlotCodec.encode(input.slot)}
      WHERE space=${input.space} AND memory_id=${input.memoryId} AND resolution_id=${input.resolutionId}
      AND revert_operation_id IS ${old.revert_operation_id} AND revert_result_json IS ${old.revert_result_json}`,
    );
  });
  const settleRevertResultTx = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    resolutionId: M.MemoryResolutionId,
    receipt: M.MemoryHubReceipt,
    revisionId: M.MemoryRevisionId | null,
  ) {
    const slot = revertSlotFromReceipt(receipt, revisionId);
    if (slot)
      yield* recordRevertResultTx({
        space,
        memoryId,
        resolutionId,
        operationId: receipt.operationId,
        slot,
        settlement: true,
      });
  });
  return {
    recordRevertResultTx,
    settleRevertResultTx,
  };
};

export type RevertResults = ReturnType<typeof makeRevertResults>;
