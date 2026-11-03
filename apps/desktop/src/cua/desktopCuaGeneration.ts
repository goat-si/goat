import * as Schema from "effect/Schema";

export class DesktopCuaGenerationExhausted extends Schema.TaggedError<DesktopCuaGenerationExhausted>()(
  "DesktopCuaGenerationExhausted",
  {},
) {}

let generation = 0;

export const nextDesktopCuaGeneration = () => {
  if (generation >= Number.MAX_SAFE_INTEGER) return undefined;
  return ++generation;
};
