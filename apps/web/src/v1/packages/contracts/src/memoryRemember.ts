import * as Schema from "effect/Schema";
import { MEMORY_BODY_MAX_UTF8_BYTES, MemoryId, MemorySpaceId } from "./memory.ts";

/** An agent's write: the server fills the space, ids, heads, project key and evidence. */
export const MemoryRememberInput = Schema.Struct({
  memorySpaceId: Schema.optionalKey(MemorySpaceId),
  text: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(
        (s) =>
          s.trim().length > 0 && new TextEncoder().encode(s).length <= MEMORY_BODY_MAX_UTF8_BYTES,
      ),
    ),
  ),
  scope: Schema.optionalKey(Schema.Literals(["user", "project", "thread"])),
  memoryId: Schema.optionalKey(MemoryId),
}).check(
  Schema.makeFilter(
    (v) =>
      v.text === undefined
        ? v.memoryId !== undefined && v.scope !== undefined
        : v.scope !== undefined || v.memoryId !== undefined,
    {
      expected: "text and a scope or memoryId, or memoryId and scope to move",
    },
  ),
);
export type MemoryRememberInput = typeof MemoryRememberInput.Type;
