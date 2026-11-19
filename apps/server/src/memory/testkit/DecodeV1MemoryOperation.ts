import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(M.MemoryOperation);

export function decodeV1MemoryOperation(
  value: unknown,
): Exclude<M.MemoryOperation, M.MemoryMoveOperation> {
  const operation = decode(value);
  if (operation.kind === "move") throw new Error("Expected a V1 fixture operation");
  return operation;
}
