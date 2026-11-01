/**
 * The strict structured-output rules GOAT's generated schemas have broken or could break: an
 * object root, closed objects whose `required` lists every property, and local `$ref`s. Codex
 * sends its `--output-schema` as a strict `json_schema` response format, and the API rejects the
 * whole request when one rule fails. This guards those rules; it is not a full validator.
 * Messages follow the API's own wording.
 *
 * @module strictOutputSchema
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Values under these keywords are data, not subschemas.
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "required"]);

/** Every rule the schema breaks, each with its location; empty when the schema is valid. */
export function strictOutputSchemaViolations(schema: unknown): ReadonlyArray<string> {
  if (!isRecord(schema) || schema.type !== "object") {
    const type = isRecord(schema) && typeof schema.type === "string" ? schema.type : "None";
    return [`schema must be a JSON Schema of 'type: "object"', got 'type: "${type}"'.`];
  }
  const violations: string[] = [];
  if (Array.isArray(schema.anyOf)) violations.push("schema: the root must not be anyOf.");
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#/$defs/")) {
      violations.push(`${path}: $ref must point into #/$defs, got ${node.$ref}.`);
    }
    const properties = isRecord(node.properties) ? node.properties : undefined;
    if (node.type === "object" || properties !== undefined) {
      if (node.additionalProperties !== false) {
        violations.push(
          `${path}: 'additionalProperties' is required to be supplied and to be false.`,
        );
      }
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const key of Object.keys(properties ?? {})) {
        if (!required.has(key)) {
          violations.push(
            `${path}: 'required' is required to include every key in properties. Missing '${key}'.`,
          );
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if (key === "properties" && isRecord(value)) {
        for (const [name, child] of Object.entries(value)) {
          visit(child, `${path}/properties/${name}`);
        }
      } else if (key === "$defs" && isRecord(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, `${path}/$defs/${name}`);
      } else {
        visit(value, `${path}/${key}`);
      }
    }
  };
  visit(schema, "schema");
  return violations;
}
