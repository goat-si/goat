import * as Schema from "effect/Schema";

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  id_token: Schema.optionalKey(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
  earliest_refresh_at: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});
const Record = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.Finite,
  earliestRefreshAt: Schema.NullOr(Schema.Finite),
  scopes: Schema.Array(Schema.String),
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  idToken: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});
export type CodexChatGptCredentials = typeof Record.Type;
const Sessions = Schema.Struct({
  activeClientId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Record),
});
const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.String),
});
const OAuthError = Schema.Struct({ error: Schema.String });
const decodeSessions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Sessions, Record])),
);
const encodeSessions = Schema.encodeEffect(Schema.fromJsonString(Sessions));
const decodeTokens = Schema.decodeUnknownSync(TokenResponse);
const decodeDiscoveryEffect = Schema.decodeUnknownEffect(Discovery);
const decodeOAuthError = Schema.decodeUnknownSync(OAuthError);

export {
  TokenResponse,
  Record,
  Sessions,
  Discovery,
  decodeSessions,
  encodeSessions,
  decodeTokens,
  decodeDiscoveryEffect,
  decodeOAuthError,
};
