import type { InteractionUpdate, ToolCall } from "@cursor/sdk";
import type { EngineHost } from "../../engine.ts";
import { assistantMessage, item, reasoning } from "../../items.ts";
import type { HelperItem } from "../../protocol.ts";
import { CursorTransportFailure } from "./transportFailure.ts";

// Adapted from v1 adapter.ts:240-282, 729-856 and turnProjection.ts:290-390.
export class CursorProjection {
  #current: { kind: "assistant" | "reasoning"; id: string; text: string } | undefined;
  #next = 0;
  #seenText = false;
  #transport = new CursorTransportFailure();
  turnEnded = false;
  get transportFailure() { return this.#transport.failure; }
  private readonly turnId: string;
  private readonly sessionId: string;
  private readonly instanceId: string;
  private readonly host: EngineHost;
  constructor(turnId: string, sessionId: string, instanceId: string, host: EngineHost) {
    this.turnId = turnId; this.sessionId = sessionId; this.instanceId = instanceId; this.host = host;
  }

  private base(id: string, nativeId = id, failed = false) {
    return { id, turnId: this.turnId, driver: "cursor", nativeId, now: this.host.now(), status: failed ? "failed" as const : "completed" as const };
  }
  private id(kind: string) { return `${this.sessionId}:${this.turnId}:${kind}:${++this.#next}`; }
  private emit(value: HelperItem, nativeId: string) {
    this.host.emit({ type: "item_completed", turnId: this.turnId, item: value, locator: { turnId: this.turnId, itemId: nativeId } });
  }
  flush() {
    const s = this.#current;
    if (!s) return;
    this.#current = undefined;
    this.emit(s.kind === "assistant" ? assistantMessage(this.base(s.id), s.text) : reasoning(this.base(s.id), s.text), s.id);
  }
  private text(kind: "assistant" | "reasoning", text: string) {
    if (this.#current?.kind !== kind) { this.flush(); if (kind === "assistant") this.#transport = new CursorTransportFailure(); }
    this.#current ??= { kind, id: this.id(kind), text: "" };
    this.#current.text += text;
    if (kind === "assistant") {
      this.#seenText = true;
      this.#transport.push(text);
      this.host.emit({ type: "text_delta", turnId: this.turnId, itemId: this.#current.id, text });
    }
  }
  update(update: InteractionUpdate) {
    if (update.type === "turn-ended") this.turnEnded = true;
    else if (["step-started", "user-message-appended", "text-delta", "thinking-delta", "partial-tool-call", "tool-call-started"].includes(update.type)) this.turnEnded = false;
    switch (update.type) {
      case "text-delta": this.text("assistant", update.text); break;
      case "thinking-delta": this.text("reasoning", update.text); break;
      case "thinking-completed": case "step-completed": case "turn-ended": this.flush(); break;
      case "tool-call-started": case "partial-tool-call":
        this.flush();
        if (update.type === "tool-call-started" && update.toolCall.type === "task") this.subagent(update.callId, update.toolCall, false);
        break;
      case "tool-call-completed":
        this.flush();
        if (update.toolCall.type === "task") this.subagent(update.callId, update.toolCall, true);
        this.tool(update.callId, update.toolCall); break;
    }
  }
  fallback(text: string | undefined) { if (!this.#seenText && text) this.text("assistant", text); }
  private subagent(callId: string, call: Extract<ToolCall, { type: "task" }>, completed: boolean) {
    this.host.emit({ type: "subagent_update", turnId: this.turnId, subagentId: call.args.agentId ?? callId,
      status: !completed ? "running" : call.result?.status === "error" ? "failed" : "completed",
      title: call.args.description || null, progress: null });
  }
  private tool(callId: string, call: ToolCall) {
    const id = `${this.sessionId}:${this.turnId}:tool:${callId}`;
    const base = this.base(id, callId, call.result?.status === "error" || (call.type === "shell" && call.result?.status === "success" && call.result.value.exitCode !== 0));
    let result: HelperItem;
    switch (call.type) {
      case "shell": result = item(base, "command_execution", { input: call.args.command, outputOmitted: true, ...(call.result?.status === "success" ? { exitCode: call.result.value.exitCode } : {}) }); break;
      case "edit": case "write": case "delete": case "generateImage":
        result = item(base, "file_change", { fileName: call.type === "generateImage" ? call.args.filePath ?? "generated-image" : call.args.path, patchOmitted: true }); break;
      case "createPlan": result = item(base, "proposed_plan", { planId: id, markdown: call.args.plan, streaming: false }); break;
      case "updateTodos": {
        const todos = call.result?.status === "success" ? call.result.value.todos : call.args.todos;
        const steps = todos.filter(t => t.status !== "cancelled" && t.content.trim()).map((t, i) => ({ id: `todo-${i + 1}`, text: t.content, status: t.status === "inProgress" ? "running" as const : t.status === "completed" ? "completed" as const : "pending" as const }));
        result = item(base, "todo_list", { planId: id, steps }); break;
      }
      case "task": result = item(base, "subagent", { subagentId: call.args.agentId ?? callId, origin: "provider_native", driver: "cursor", providerInstanceId: this.instanceId, childThreadId: null, prompt: call.args.prompt, result: call.result?.status === "success" ? call.result.value.resultSuffix ?? null : null }); break;
      default: {
        const name = call.type === "read" ? "Read" : call.type === "mcp" ? `mcp__${call.args.providerIdentifier ?? "mcp"}__${call.args.toolName ?? "unknown"}` : call.type;
        result = item(base, "dynamic_tool", { toolName: name, input: (call.type === "mcp" ? call.args.args ?? {} : call.args) as never, outputOmitted: true });
      }
    }
    this.emit(result, callId);
  }
}
