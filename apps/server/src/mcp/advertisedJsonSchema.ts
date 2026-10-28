import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Predicate from "effect/Predicate";
import type * as SchemaAST from "effect/SchemaAST";
import { McpSchema, Tool } from "effect/ai";

import { withParameterNotes, withTypeSideDescriptions } from "./servedDescriptions.ts";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/**
 * One object for a tagged union of objects: each property once, the tag listing every value.
 * It stays closed when every branch is; a union mixing closed and open branches is left alone.
 */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      !Predicate.isObject(branch.additionalProperties) &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const closed = objects.filter((object) => object.additionalProperties === false).length;
  if (closed !== 0 && closed !== objects.length) return undefined;
  const tag = Object.keys(objects[0]?.properties ?? {}).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return (
      objects.every((object) => Array.isArray(object.required) && object.required.includes(key)) &&
      values.every((value) => typeof value === "string") &&
      new Set(values).size === values.length
    );
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return {
    type: "object",
    properties,
    required: [tag, ...requiredByAll],
    ...(closed === 0 ? {} : { additionalProperties: false }),
  };
};

const compact = (schema: Json): Json => {
  if (Array.isArray(schema)) return schema.map(compact);
  if (!Predicate.isObject(schema)) return schema;
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (["enum", "const", "default", "examples"].includes(key)) {
      result[key] = value;
      continue;
    }
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [name, compact(property)]),
          )
        : compact(value);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = [
      ...new Map(
        result.anyOf
          .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
          .map((branch) => [JSON.stringify(branch), branch]),
      ).values(),
    ];
    if (
      branches.some(
        (branch) => Predicate.isObject(branch) && ["object", "array"].includes(String(branch.type)),
      )
    ) {
      const preferred = branches.filter((branch) => !isJsonStringSchema(branch));
      branches.splice(0, branches.length, ...preferred);
    }
    const merged = mergeTaggedObjects(branches.filter((branch) => !isNullSchema(branch)));
    if (merged !== undefined)
      branches.splice(0, branches.length, merged, ...branches.filter(isNullSchema));
    const { anyOf: _anyOf, ...rest } = result;
    const only = branches.length === 1 ? branches[0] : undefined;
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

const notesOf = (entry: AgentSurfaceEntry | undefined) => entry?.parameters;

const withRequiredKey = (entry: AgentSurfaceEntry | undefined, schema: JsonObject) => {
  if (!entry?.keyRequired) return schema;
  const properties = schema.properties as JsonObject;
  const key = properties.clientRequestId as JsonObject;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    required: [...new Set([...required, "clientRequestId"])],
    properties: {
      ...properties,
      clientRequestId: Array.isArray(key.anyOf)
        ? { ...key, anyOf: key.anyOf.filter((branch) => !isNullSchema(branch)) }
        : key,
    },
  };
};

/** What the decoded schema and then the path's registry entry say about each argument. */
const describedInput = (name: string, schema: JsonObject, parameters?: SchemaAST.AST) =>
  withRequiredKey(
    resolveAgentSurfaceEntry(name),
    withParameterNotes(
      notesOf(resolveAgentSurfaceEntry(name)),
      parameters === undefined ? schema : withTypeSideDescriptions(parameters, schema),
    ),
  );

/**
 * Compact model-facing inputs only; runtime codecs still enforce each union branch.
 * Nullable alternatives may clear stored values even on optional properties; preserve them.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(
    describedInput(tool.name, Tool.getJsonSchema(tool) as JsonObject, tool.parametersSchema.ast),
  ) as ReturnType<typeof Tool.getJsonSchema>;

/** parameters is the registered tool's own schema, whose decoded side carries descriptions. */
export const advertisedRegistration = <Registration extends { readonly tool: McpSchema.Tool }>(
  registration: Registration,
  parameters?: SchemaAST.AST,
): Registration => ({
  ...registration,
  tool: new McpSchema.Tool({
    ...registration.tool,
    inputSchema: compact(
      describedInput(
        registration.tool.name,
        registration.tool.inputSchema as JsonObject,
        parameters,
      ),
    ) as ReturnType<typeof Tool.getJsonSchema>,
  }),
});
