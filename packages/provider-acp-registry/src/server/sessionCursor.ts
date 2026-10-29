import * as Schema from "effect/Schema";

const PREFIX = "goat-acp:v1:";
const MAX_CURSOR_LENGTH = 2_048;
const Cursor = Schema.Struct({
  providerCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_CURSOR_LENGTH))),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
});
type Cursor = typeof Cursor.Type;
const isCursor = Schema.is(Cursor);

export function decodeSessionCursor(cursor: string | undefined): Cursor | undefined {
  if (cursor === undefined) return { providerCursor: null, offset: 0 };
  if (cursor.length > MAX_CURSOR_LENGTH) return undefined;
  if (!cursor.startsWith(PREFIX)) return { providerCursor: cursor, offset: 0 };
  const payload = cursor.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return undefined;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isCursor(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function encodeSessionCursor(cursor: Cursor): string | undefined {
  if (!isCursor(cursor)) return undefined;
  const encoded = PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return encoded.length <= MAX_CURSOR_LENGTH ? encoded : undefined;
}
