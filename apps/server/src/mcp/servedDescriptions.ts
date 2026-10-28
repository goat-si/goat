import * as Predicate from "effect/Predicate";
import * as SchemaAST from "effect/SchemaAST";

type JsonObject = { [key: string]: unknown };

// JSON Schema shows a transformation's encoded side, so a description annotated on the decoded
// side, as on every TrimmedNonEmptyString field, never reaches the advertised schema.

const isNullSchema = (value: unknown) =>
  Predicate.isObject(value) && value["type"] === "null" && Object.keys(value).length === 1;

/** The schema an optional field holds: the one member besides undefined. */
const present = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast._tag !== "Union") return ast;
  const members = ast.types.filter((member) => member._tag !== "Undefined");
  const [only] = members;
  return members.length === 1 && only !== undefined && members.length < ast.types.length
    ? only
    : ast;
};

/** A nullable property's one non-null branch, which carries what the field holds. */
const valueBranch = (property: JsonObject): JsonObject | undefined => {
  if (!Array.isArray(property["anyOf"])) return property;
  const branches = property["anyOf"].filter((branch) => !isNullSchema(branch));
  const [only] = branches;
  return branches.length === 1 && Predicate.isObject(only) ? only : undefined;
};

/**
 * Fills each property's missing description from the decoded schema, recursing into nested
 * objects; properties that already state one keep it.
 */
export const withTypeSideDescriptions = (ast: SchemaAST.AST, schema: JsonObject): JsonObject => {
  const properties = schema["properties"];
  if (ast._tag !== "Objects" || !Predicate.isObject(properties)) return schema;
  const filled: JsonObject = { ...properties };
  for (const signature of ast.propertySignatures) {
    const name = signature.name;
    const property = typeof name === "string" ? filled[name] : undefined;
    if (typeof name !== "string" || !Predicate.isObject(property)) continue;
    const held = present(signature.type);
    const branch = valueBranch(property);
    let next: JsonObject = property;
    if (branch !== undefined && held._tag === "Objects") {
      const nested = withTypeSideDescriptions(held, branch);
      next =
        branch === property
          ? nested
          : {
              ...property,
              anyOf: (property["anyOf"] as ReadonlyArray<unknown>).map((option) =>
                option === branch ? nested : option,
              ),
            };
    }
    const stated = next["description"] ?? branch?.["description"];
    const description =
      SchemaAST.resolveDescription(signature.type) ?? SchemaAST.resolveDescription(held);
    filled[name] =
      stated === undefined && description !== undefined ? { description, ...next } : next;
  }
  return { ...schema, properties: filled };
};

const described = (property: JsonObject) =>
  property["description"] !== undefined || valueBranch(property)?.["description"] !== undefined;

/** Puts a registry entry's argument notes on the properties they name that state nothing. */
export const withParameterNotes = (
  notes: Readonly<Record<string, string>> | undefined,
  schema: JsonObject,
): JsonObject => {
  if (notes === undefined) return schema;
  const note = (target: JsonObject, path: ReadonlyArray<string>, text: string): JsonObject => {
    const [name, ...rest] = path;
    const properties = target["properties"];
    if (name === undefined || !Predicate.isObject(properties)) return target;
    const property = properties[name];
    if (!Predicate.isObject(property)) return target;
    let next: JsonObject = property;
    if (rest.length === 0) {
      if (described(property)) return target;
      next = { description: text, ...property };
    } else {
      const branch = valueBranch(property);
      if (branch === undefined) return target;
      const nested = note(branch, rest, text);
      next =
        branch === property
          ? nested
          : {
              ...property,
              anyOf: (property["anyOf"] as ReadonlyArray<unknown>).map((option) =>
                option === branch ? nested : option,
              ),
            };
    }
    return { ...target, properties: { ...properties, [name]: next } };
  };
  return Object.entries(notes).reduce(
    (current, [path, text]) => note(current, path.split("."), text),
    schema,
  );
};
