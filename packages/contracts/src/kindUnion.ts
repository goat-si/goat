import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";

function encodedKind(member: Schema.Top): string {
  const encoded = SchemaAST.toEncoded(member.ast);
  const kind = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "kind")?.type
    : undefined;
  if (kind !== undefined && SchemaAST.isLiteral(kind) && typeof kind.literal === "string") {
    return kind.literal;
  }
  throw new Error("Each member of a kind union needs a literal string `kind`.");
}

/** A union keyed by a literal `kind` whose unknown kinds decode to `fallback`, so older clients keep working. */
export function kindUnionWithFallback<
  const Members extends ReadonlyArray<Schema.Top & { readonly Encoded: { readonly kind: string } }>,
  Unknown extends Schema.Top,
>(
  members: Members,
  unknown: (kind: Schema.optional<Schema.String>) => Unknown,
  fallback: (value: Unknown["Type"]) => Schema.Union<Members>["Encoded"],
) {
  const knownKinds: ReadonlySet<string> = new Set(members.map(encodedKind));
  const unknownKind = unknown(
    Schema.optional(
      Schema.String.check(
        Schema.makeFilter(
          (kind: string) => !knownKinds.has(kind) || "A known kind must decode in full.",
        ),
      ),
    ),
  ).pipe(
    Schema.decodeTo(Schema.Union(members), {
      decode: SchemaGetter.transform(fallback),
      encode: SchemaGetter.forbidden(() => "Unknown kinds are decode-only."),
    }),
  );
  return Schema.Union([...members, unknownKind]);
}
