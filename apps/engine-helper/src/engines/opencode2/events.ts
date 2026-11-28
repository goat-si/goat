// Text, compaction and context usage adapted from v1 v2/adapter.ts:458-480, 1240-1285,
// 1680-1800 at 916b5ccc1b. The session owns event filtering and lifetime.
import type { V2Event, TokenUsageInfo } from "@opencode/client";
import type { EngineHost } from "../../engine.ts";
import { assistantMessage, item, reasoning } from "../../items.ts";

type TextState = { kind: "text" | "reasoning"; message: string; text: string; sent: string; completed: boolean };
type ContextUsage = { usedTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };

function contextUsage(tokens: TokenUsageInfo | undefined): ContextUsage | undefined {
  if (!tokens?.cache) return undefined;
  const { input, output, reasoning: reason, cache: { read, write } } = tokens;
  if (![input, output, reason, read, write].every((v) => Number.isSafeInteger(v) && v >= 0)) return undefined;
  const inputTokens = input + read + write; const usedTokens = inputTokens + output;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(usedTokens)) return undefined;
  return { usedTokens, inputTokens, cachedInputTokens: read, outputTokens: output, reasoningOutputTokens: reason };
}

export class OpenCode2Projection {
  private readonly texts = new Map<string, TextState>();
  private readonly seen = new Set<string>();
  private lastUsage: ContextUsage | undefined;
  private compactionId: string | undefined;
  private compactionCount = 0;
  private readonly host: EngineHost;
  private readonly turnId: string;
  constructor(host: EngineHost, turnId: string) { this.host = host; this.turnId = turnId; }
  private base(id: string) { return { id, nativeId: id, turnId: this.turnId, driver: "opencode", now: this.host.now() }; }
  private emitText(id: string, state: TextState) {
    if (state.kind !== "text" || state.completed) return;
    if (!state.text.startsWith(state.sent)) throw new Error("OpenCode text changed after streaming");
    const suffix = state.text.slice(state.sent.length);
    if (suffix) this.host.emit({ type: "text_delta", turnId: this.turnId, itemId: id, text: suffix });
    state.sent = state.text;
  }
  private completeText(id: string, state: TextState) {
    if (state.completed) return;
    this.emitText(id, state); state.completed = true;
    this.host.emit({ type: "item_completed", turnId: this.turnId, item: state.kind === "text" ? assistantMessage(this.base(id), state.text, state.message) : reasoning(this.base(id), state.text), locator: { turnId: this.turnId, itemId: id } });
  }
  handle(event: V2Event): boolean {
    if (!["session.text.started", "session.text.delta", "session.text.ended", "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.step.ended", "session.step.failed", "session.compaction.started", "session.compaction.ended", "session.compaction.failed"].includes(event.type)) return false;
    if (this.seen.has(event.id)) return true;
    if (this.seen.size >= 16384) throw new Error("OpenCode event limit exceeded");
    this.seen.add(event.id);
    switch (event.type) {
      case "session.text.started": case "session.text.delta": case "session.text.ended":
      case "session.reasoning.started": case "session.reasoning.delta": case "session.reasoning.ended": {
        const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
        const data = event.data; const id = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
        let state = this.texts.get(id);
        if (!state) { state = { kind, message: data.assistantMessageID, text: "", sent: "", completed: false }; this.texts.set(id, state); }
        if (state.completed) return true;
        if ("delta" in data) state.text += data.delta;
        else if ("text" in data) state.text = data.text;
        this.emitText(id, state);
        if (event.type.endsWith(".ended")) this.completeText(id, state);
        return true;
      }
      case "session.step.ended": case "session.step.failed": {
        const usage = contextUsage(event.data.tokens); if (usage) this.lastUsage = usage;
        return true;
      }
      case "session.compaction.started":
        this.compactionId = `${this.turnId}:compaction:${this.compactionCount++}`; this.lastUsage = undefined; return true;
      case "session.compaction.ended": case "session.compaction.failed": {
        const id = this.compactionId ?? `${this.turnId}:compaction:${this.compactionCount++}`; this.compactionId = undefined;
        this.lastUsage = undefined;
        const summary = event.type === "session.compaction.ended" ? event.data.text : "OpenCode compaction failed";
        this.host.emit({ type: "item_completed", turnId: this.turnId, item: item({ ...this.base(id), title: "Context compacted", status: event.type === "session.compaction.ended" ? "completed" : "failed" }, "compaction", { driver: "opencode", summary }), locator: { turnId: this.turnId, itemId: id } });
        return true;
      }
      default: return false;
    }
  }
  finish(maxTokens?: number) {
    for (const [id, state] of this.texts) this.completeText(id, state);
    if (this.lastUsage) this.host.emit({ type: "token_usage", turnId: this.turnId, usage: { ...this.lastUsage, ...(typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}) } });
  }
}
