import {
  AuthSessionId,
  AuthEnvironmentScopes,
  AuthWebSocketTicketUse,
  ChildSetupPurpose,
  RuntimeMode,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  csp: Schema.optionalKey(ChildSetupPurpose),
  iat: Schema.Number,
  exp: Schema.Number,
});
export type SessionClaims = typeof SessionClaims.Type;

export const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  aud: Schema.optionalKey(AuthWebSocketTicketUse),
  jkt: Schema.optionalKey(Schema.String),
  iat: Schema.Number,
  exp: Schema.Number,
});
export type WebSocketClaims = typeof WebSocketClaims.Type;

export const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
export const decodeWebSocketClaims = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WebSocketClaims),
);
