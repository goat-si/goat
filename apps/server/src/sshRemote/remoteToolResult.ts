interface CallToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/** Reads a remote `tools/call` result: its structured payload, or the refusal and code it returned. */
export function readRemoteToolResult(
  tool: string,
  raw: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string; readonly code?: string } {
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as CallToolResult;
  const text = result.content?.find((item) => item.type === "text")?.text;
  let payload: unknown = result.structuredContent;
  if (payload === undefined && text !== undefined) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (result.isError === true) {
    const fields =
      typeof payload === "object" && payload !== null
        ? (payload as { readonly message?: unknown; readonly code?: unknown })
        : {};
    const message = "message" in fields ? String(fields.message) : (text ?? "no details");
    return {
      ok: false,
      message: `The remote ${tool} refused: ${message}`,
      ...(typeof fields.code === "string" ? { code: fields.code } : {}),
    };
  }
  return { ok: true, value: payload };
}
