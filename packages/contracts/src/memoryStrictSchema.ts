import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

// The declaration preserves strict parsing when Effect derives encode, make, and RPC codecs.
export const strictSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      toCodecJson: () => undefined,
    },
  );
