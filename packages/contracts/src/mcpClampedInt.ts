import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { PositiveInt } from "./baseSchemas.ts";

// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on decode
// (pagination returns the rest). Below 1 still fails: 0 asks for nothing, so one item would differ.
export const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );
