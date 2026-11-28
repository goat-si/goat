// v1 CursorAgentSdk.ts:46-64: Cursor uses codes as well as HTTP 429 for quota errors.
const usageCode = /^(?:resource_exhausted|rate_limited(?:_changeable)?|\w*_usage_limit|\w*_rate_limit(?:_exceeded)?)$/i;
export function cursorFailure(cause: unknown): { message: string; kind: "usage_limit" | "permission_error" | "transport_error" | "provider_error"; auth: boolean } {
  if (cause && typeof cause === "object") {
    const name = String(Reflect.get(cause, "name") ?? "");
    const code = String(Reflect.get(cause, "code") ?? "");
    const status = Reflect.get(cause, "status");
    if (name === "RateLimitError" || status === 429 || usageCode.test(code)) return { message: "Cursor usage limit reached.", kind: "usage_limit", auth: false };
    if (name === "AuthenticationError" || status === 401 || /unauthenticated|unauthorized/i.test(code)) return { message: "Cursor authentication failed. Sign in or configure an API key.", kind: "permission_error", auth: true };
    if (name === "NetworkError" || /unavailable|deadline_exceeded/i.test(code)) return { message: "Cursor transport failed.", kind: "transport_error", auth: false };
  }
  return { message: "Cursor SDK run failed.", kind: "provider_error", auth: false };
}
