import type { EngineHost } from "../../engine.ts";
import type { EngineEvent, InitializeParams } from "../../protocol.ts";

// Redact known credentials before any engine-produced text reaches the host.
export function safeHost(host: EngineHost, params: InitializeParams, extraSecrets: ReadonlyArray<string> = []): EngineHost {
  const secrets = new Set<string>(extraSecrets.filter((secret) => secret.length >= 8));
  if (params.mcp?.bearerToken) secrets.add(params.mcp.bearerToken);
  for (const [key, value] of Object.entries({ ...process.env, ...params.launch?.env })) {
    if (/(?:token|secret|password|api[_-]?key|authorization)/i.test(key) && value && value.length >= 8) secrets.add(value);
  }
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const secret of secrets) result = result.replaceAll(secret, "[redacted]");
      return result;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
    return value;
  };
  // Retain a suffix across deltas so a credential split between chunks cannot escape.
  const pending = new Map<string, { turnId: string; text: string; streamKind?: Extract<EngineEvent, { type: "content_delta" }>["streamKind"] }>();
  const max = Math.max(1, ...Array.from(secrets, (secret) => secret.length));
  const flush = (id: string, final: boolean) => {
    const entry = pending.get(id); if (!entry) return;
    let limit = final ? entry.text.length : Math.max(0, entry.text.length - max + 1);
    for (const secret of secrets) {
      let from = 0;
      while (from < limit) {
        const index = entry.text.indexOf(secret, from);
        if (index < 0 || index >= limit) break;
        if (index + secret.length > limit) limit = index;
        from = index + secret.length;
      }
    }
    const prefix = entry.text.slice(0, limit);
    entry.text = entry.text.slice(limit);
    if (prefix) host.emit(entry.streamKind === undefined
      ? { type: "text_delta", turnId: entry.turnId, itemId: id, text: clean(prefix) as string }
      : { type: "content_delta", turnId: entry.turnId, itemId: id, streamKind: entry.streamKind, text: clean(prefix) as string });
    if (final) pending.delete(id);
  };
  return { now: () => host.now(), emit: (event) => {
    if (event.type === "text_delta" || event.type === "content_delta") {
      const entry = pending.get(event.itemId) ?? { turnId: event.turnId, text: "", ...(event.type === "content_delta" ? { streamKind: event.streamKind } : {}) };
      entry.text += event.text; pending.set(event.itemId, entry); flush(event.itemId, false); return;
    }
    if (event.type === "item_completed") flush(event.item.id, true);
    if (event.type === "turn_finished" || event.type === "exited") for (const id of pending.keys()) flush(id, true);
    host.emit(clean(event) as typeof event);
  }, log: (level, message) => host.log(level, clean(message) as string), fail: (reason) => host.fail(clean(reason) as string) };
}
