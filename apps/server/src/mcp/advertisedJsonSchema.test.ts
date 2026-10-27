import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("keeps tagged record schemas and optional discriminators as unions", () => {
  const branches = ["read", "write"].map((kind) => ({
    type: "object" as const,
    properties: { kind: { type: "string" as const, enum: [kind] } },
  }));
  const records = branches.map((branch) => ({
    ...branch,
    required: ["kind"],
    additionalProperties: { type: "string" as const },
  }));
  const tool = Tool.dynamic("example", {
    description: "Example",
    parameters: {
      type: "object",
      properties: { optionalTag: { anyOf: branches }, record: { anyOf: records } },
    },
  });
  expect(advertisedJsonSchema(tool).properties).toEqual({
    optionalTag: { anyOf: branches },
    record: { anyOf: records },
  });
});

it("keeps validation limits, record values and JSON-shaped literal data intact", () => {
  const literal = { type: "integer", maximum: Number.MAX_SAFE_INTEGER, additionalProperties: true };
  const tool = Tool.dynamic("example", {
    description: "Example",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20 },
        record: { type: "object", additionalProperties: { type: "string" } },
        data: { const: literal, default: literal, examples: [literal] },
        json: { anyOf: [{ type: "string", contentMediaType: "application/json" }] },
        nullableJson: {
          anyOf: [{ type: "null" }, { type: "string", contentMediaType: "application/json" }],
        },
      },
      additionalProperties: false,
      required: ["nullableJson"],
    },
  });
  expect(advertisedJsonSchema(tool)).toMatchObject({
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 20 },
      record: { type: "object", additionalProperties: { type: "string" } },
      data: { const: literal, default: literal, examples: [literal] },
      json: { type: "string", contentMediaType: "application/json" },
      nullableJson: {
        anyOf: [{ type: "null" }, { type: "string", contentMediaType: "application/json" }],
      },
    },
  });
});

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      nothing: Schema.optional(Schema.Null),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      nothing: { type: "null" },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});
