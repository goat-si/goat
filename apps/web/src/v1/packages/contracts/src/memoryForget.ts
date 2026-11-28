import * as Schema from "effect/Schema";
import { MemoryId, MemoryOperationId, MemoryRevisionId, MemorySpaceId } from "./memory.ts";

export const McpMemoryForgetInput = Schema.Struct({
  memoryId: MemoryId,
  memorySpaceId: Schema.optionalKey(MemorySpaceId),
  operationId: Schema.optionalKey(MemoryOperationId),
  expectedHeads: Schema.optionalKey(Schema.Array(MemoryRevisionId)),
}).check(
  Schema.makeFilter(
    ({ operationId, expectedHeads }) =>
      (operationId === undefined) === (expectedHeads === undefined),
    { expected: "operationId and expectedHeads together, or memoryId alone" },
  ),
);
