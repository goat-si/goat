import { expect, it } from "@effect/vitest";
import { FAILURE_CLASSES } from "@goat/contracts/agentSurface/envelope";
import { Tool } from "effect/ai";

import { toolkits as standardToolkits } from "./agentSurface.testkit.ts";
import { ScreenToolkit } from "./toolkits/screen/tools.ts";

const toolkits = { ...standardToolkits, screen: ScreenToolkit };

type JsonNode = Readonly<Record<string, unknown>>;
const literalsOf = (node: unknown, resolve: (node: unknown) => JsonNode | undefined): string[] => {
  const schema = resolve(node);
  if (schema === undefined) return [];
  if (typeof schema.const === "string") return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.filter((value) => typeof value === "string");
  for (const key of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[key]))
      return schema[key].flatMap((member) => literalsOf(member, resolve));
  return [];
};
/** Domain literals a schema can return as a failure: tagged errors, and refusal arms of results. */
const failureLiterals = (root: unknown, onlyRefusals: boolean): ReadonlyArray<string> => {
  const defs = ((root as JsonNode).$defs ?? {}) as Readonly<Record<string, JsonNode>>;
  const resolve = (node: unknown): JsonNode | undefined => {
    const fields = node as JsonNode | undefined;
    if (fields === undefined || typeof fields !== "object") return undefined;
    const ref = fields.$ref;
    return typeof ref === "string" ? resolve(defs[ref.replace("#/$defs/", "")]) : fields;
  };
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    const schema = resolve(node);
    if (schema === undefined || seen.has(schema)) return;
    seen.add(schema);
    const properties = schema.properties as Readonly<Record<string, unknown>> | undefined;
    if (properties !== undefined) {
      const tags = literalsOf(properties._tag, resolve);
      const kinds = [
        ...literalsOf(properties.kind, resolve),
        ...literalsOf(properties.status, resolve),
      ];
      const isFailure = onlyRefusals
        ? kinds.some((kind) => kind === "error" || kind === "refused")
        : tags.length > 0;
      if (isFailure) {
        const reasons = ["code", "reason", "failureCode"].flatMap((key) =>
          literalsOf(properties[key], resolve),
        );
        for (const literal of reasons.length > 0 ? reasons : tags) found.add(literal);
      }
      for (const value of Object.values(properties)) walk(value);
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const)
      if (Array.isArray(schema[key])) for (const member of schema[key]) walk(member);
    if (schema.items !== undefined) walk(schema.items);
  };
  walk(root);
  return [...found];
};

it("classifies every domain failure literal the served tools can return", () => {
  const missing = new Map<string, Set<string>>();
  for (const toolkit of Object.values(toolkits))
    for (const tool of Object.values<Tool.Any>(toolkit.tools)) {
      const literals = [
        ...failureLiterals(Tool.getJsonSchemaFromSchema(tool.failureSchema), false),
        ...failureLiterals(Tool.getJsonSchemaFromSchema(tool.successSchema), true),
      ];
      for (const literal of literals)
        if (FAILURE_CLASSES[literal] === undefined)
          missing.set(literal, (missing.get(literal) ?? new Set()).add(tool.name));
    }
  expect(
    Object.fromEntries([...missing].map(([literal, names]) => [literal, [...names].sort()])),
  ).toEqual({});
});
