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

it("drops JSON noise, merges tagged unions, and preserves optional and required nulls", () => {
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
      threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      nothing: { type: "null" },
      limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["url", "number"] },
              url: { type: "string" },
              number: { type: "integer" },
            },
            required: ["kind"],
          },
          { type: "null" },
        ],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("keeps a merged tagged union closed only when every branch refuses extra keys", () => {
  const branch = (kind: string, extra: Record<string, unknown>, closed: boolean) => ({
    type: "object",
    properties: { kind: { type: "string", enum: [kind] }, ...extra },
    required: ["kind"],
    ...(closed ? { additionalProperties: false } : {}),
  });
  // The memory scope shape: a closed tagged union nested in a closed tagged union.
  const projectKey = {
    anyOf: [
      branch("repository", { groupingKey: { type: "string" } }, true),
      branch("explicit", { sharedProjectId: { type: "string" } }, true),
    ],
  };
  const tool = Tool.dynamic("example", {
    description: "Example",
    parameters: {
      type: "object",
      properties: {
        scope: {
          anyOf: [branch("user", {}, true), branch("project", { projectKey }, true)],
        },
        nullable: { anyOf: [branch("a", {}, true), branch("b", {}, true), { type: "null" }] },
        mixed: { anyOf: [branch("a", {}, true), branch("b", {}, false)] },
        open: { anyOf: [branch("a", {}, false), branch("b", {}, false)] },
      },
      additionalProperties: false,
    },
  });
  const tag = (...kinds: Array<string>) => ({ type: "string", enum: kinds });

  expect(advertisedJsonSchema(tool).properties).toEqual({
    scope: {
      type: "object",
      properties: {
        kind: tag("user", "project"),
        projectKey: {
          type: "object",
          properties: {
            kind: tag("repository", "explicit"),
            groupingKey: { type: "string" },
            sharedProjectId: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    nullable: {
      anyOf: [
        {
          type: "object",
          properties: { kind: tag("a", "b") },
          required: ["kind"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    mixed: { anyOf: [branch("a", {}, true), branch("b", {}, false)] },
    open: { type: "object", properties: { kind: tag("a", "b") }, required: ["kind"] },
  });
});
