import { GOAT_CHECKPOINT_REFS_PREFIX } from "@goat/contracts/legacyT3Names";
import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, type ThreadId } from "@goat/contracts";

const CHECKPOINT_REFS_PREFIX = GOAT_CHECKPOINT_REFS_PREFIX;

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}
