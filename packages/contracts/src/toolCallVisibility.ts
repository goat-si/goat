import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** Labs: how much of an agent's tool work a thread shows. Zen shows only final answers. */
export const ToolCallVisibility = Schema.Literals(["showAll", "hideSuccessful", "hideAll", "zen"]);
export type ToolCallVisibility = typeof ToolCallVisibility.Type;

// A value a newer client stored reads as showAll here instead of failing every client setting.
const UnknownToolCallVisibility = Schema.String.pipe(
  Schema.decodeTo(
    ToolCallVisibility,
    SchemaTransformation.transform({
      decode: (_stored: string): ToolCallVisibility => "showAll",
      encode: (visibility: ToolCallVisibility): string => visibility,
    }),
  ),
);

export const ToolCallVisibilitySetting = Schema.Union([
  ToolCallVisibility,
  UnknownToolCallVisibility,
]).pipe(Schema.withDecodingDefault(Effect.succeed("showAll" as const)));
