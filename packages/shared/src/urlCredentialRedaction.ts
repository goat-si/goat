import * as Cause from "effect/Cause";

// WebSocket tickets and DPoP proofs remain sensitive in failed-upgrade URLs.
const URL_CREDENTIAL_PARAMS = /(^|[?&"\s])(wsTicket|dpop)=[^&#"\\\s]*/g;

export const redactUrlCredentials = (text: string) =>
  text.replace(URL_CREDENTIAL_PARAMS, "$1$2=<redacted>");

export function redactCauseCredentials(cause: Cause.Cause<unknown>): Cause.Cause<unknown> {
  if (cause.reasons.length === 0 || Cause.hasInterruptsOnly(cause)) return cause;
  const pretty = Cause.pretty(cause);
  const redacted = redactUrlCredentials(pretty);
  return redacted === pretty ? cause : Cause.die(new Error(redacted));
}
