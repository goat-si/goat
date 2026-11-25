import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

type JsonObject = { [key: string]: unknown };

const isNullSchema = (value: unknown) =>
  Predicate.isObject(value) && value["type"] === "null" && Object.keys(value).length === 1;

const members = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  ast._tag === "Union" ? ast.types.flatMap(members) : [ast];

/** A property's one branch besides null, or the property itself when it is no union. */
const valueBranch = (property: JsonObject): JsonObject | undefined => {
  if (!Array.isArray(property["anyOf"])) return property;
  const branches = property["anyOf"].filter((branch) => !isNullSchema(branch));
  const [only] = branches;
  return branches.length === 1 && Predicate.isObject(only) ? only : undefined;
};

const STATING_KEYS = ["type", "anyOf", "oneOf", "allOf", "$ref", "enum", "const", "items"];

/** States nothing a caller can act on: {} or an object whose every key is {}. */
const isOpaque = (schema: JsonObject): boolean => {
  if (!STATING_KEYS.some((key) => key in schema)) return true;
  const properties = schema["properties"];
  if (schema["type"] !== "object" || !Predicate.isObject(properties)) return false;
  const values = Object.values(properties);
  return (
    values.length > 0 &&
    values.every((value) => {
      const branch = Predicate.isObject(value) ? valueBranch(value) : undefined;
      return branch !== undefined && isOpaque(branch);
    })
  );
};

/** The decoded side's schema, when it stands alone without shared definitions. */
const decodedShape = (ast: SchemaAST.AST): JsonObject | undefined => {
  const document = Schema.toJsonSchemaDocument(Schema.make(SchemaAST.toType(ast)));
  const shape: unknown = document.schema;
  return Object.keys(document.definitions).length === 0 &&
    Predicate.isObject(shape) &&
    !isOpaque(shape)
    ? shape
    : undefined;
};

const withoutNull = (property: JsonObject): JsonObject => {
  const { anyOf, ...rest } = property;
  if (!Array.isArray(anyOf) || !anyOf.some(isNullSchema)) return property;
  const kept = anyOf.filter((branch) => !isNullSchema(branch));
  const [only] = kept;
  return kept.length === 1 && Predicate.isObject(only)
    ? { ...only, ...rest }
    : { ...rest, anyOf: kept };
};

/**
 * Effect advertises Schema.optional as T | null, where null only stands for an omitted key, and an
 * input decoded from Unknown fields as {}. Antigravity's Gemini declarations keep no type for
 * either. Each property keeps null only where its input accepts null itself, and an opaque one
 * shows the shape it decodes to.
 */
export const withReadableShapes = (ast: SchemaAST.AST, schema: JsonObject): JsonObject => {
  const properties = schema["properties"];
  if (ast._tag !== "Objects" || !Predicate.isObject(properties)) return schema;
  const shaped: JsonObject = { ...properties };
  for (const signature of ast.propertySignatures) {
    const name = signature.name;
    const declared = typeof name === "string" ? shaped[name] : undefined;
    if (typeof name !== "string" || !Predicate.isObject(declared)) continue;
    const acceptsNull = members(SchemaAST.toEncoded(signature.type)).some(
      (member) => member._tag === "Null",
    );
    const property = acceptsNull ? declared : withoutNull(declared);
    const branch = valueBranch(property);
    const held = members(signature.type).filter(
      (member) => member._tag !== "Undefined" && member._tag !== "Null",
    );
    const [only] = held;
    if (branch === undefined || held.length !== 1 || only === undefined) {
      shaped[name] = property;
      continue;
    }
    const next = isOpaque(branch)
      ? (decodedShape(only) ?? branch)
      : withReadableShapes(only, branch);
    shaped[name] =
      branch === property
        ? { ...next, ...(next === branch ? {} : descriptionOf(property)) }
        : {
            ...property,
            anyOf: (property["anyOf"] as ReadonlyArray<unknown>).map((option) =>
              option === branch ? next : option,
            ),
          };
  }
  return { ...schema, properties: shaped };
};

const descriptionOf = (property: JsonObject) =>
  property["description"] === undefined ? {} : { description: property["description"] };
