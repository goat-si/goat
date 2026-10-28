// @effect-diagnostics nodeBuiltinImport:off -- Process-local MACs bind handles to authenticated opener identities.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const Token = Schema.Struct({
  environment: Schema.String,
  threadId: Schema.String,
  terminalId: Schema.String,
  generation: Schema.String,
  owner: Schema.String,
  binding: Schema.NullOr(Schema.String),
  root: Schema.String,
  mutable: Schema.Boolean,
  position: Schema.optionalKey(Schema.Number),
});
export type TerminalToken = typeof Token.Type;
const encode = Schema.encodeSync(Schema.fromJsonString(Token));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Token));

export function makeTerminalTokens() {
  const secret = NodeCrypto.randomBytes(32);
  const mac = (body: string) =>
    NodeCrypto.createHmac("sha256", secret).update(body).digest("base64url");
  return {
    issue: (value: TerminalToken) => {
      const body = Buffer.from(encode(value)).toString("base64url");
      return `${body}.${mac(body)}`;
    },
    read: (value: string) => {
      const [body, signature, extra] = value.split(".");
      if (!body || !signature || extra !== undefined || value.length > 16384)
        throw new TypeError("Invalid handle.");
      const expected = mac(body);
      if (
        signature.length !== expected.length ||
        !NodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        throw new TypeError("Expired or invalid handle.");
      return decode(Buffer.from(body, "base64url").toString("utf8"));
    },
  };
}
