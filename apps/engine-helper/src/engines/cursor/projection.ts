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
  #pending = new Map<string, ToolCall>();
  #shellOutput = new Map<string, string>();
  turnEnded = false;
  get transportFailure() { return this.#transport.failure; }
  private readonly turnId: string;
  private readonly sessionId: string;
  private readonly instanceId: string;
  private readonly host: EngineHost;
  constructor(turnId: string, sessionId: string, instanceId: string, host: EngineHost) {
    this.turnId = turnId; this.sessionId = sessionId; this.instanceId = instanceId; this.host = host;
  }

  private base(id: string, nativeId = id, status: "completed" | "failed" | "interrupted" = "completed") {
    return { id, turnId: this.turnId, driver: "cursor", nativeId, now: this.host.now(), status };
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
        if (update.type === "partial-tool-call" && update.toolCall.type === "task") break;
        if (update.toolCall.type === "task" && !this.#pending.has(update.callId)) this.subagent(update.callId, update.toolCall, "running");
        this.#pending.set(update.callId, update.toolCall);
        break;
      case "tool-call-completed":
        this.flush();
        this.#pending.delete(update.callId);
        if (update.toolCall.type === "task") this.subagent(update.callId, update.toolCall, update.toolCall.result?.status === "error" ? "failed" : "completed");
        this.tool(update.callId, update.toolCall); break;
      case "shell-output-delta": {
        const id = typeof update.event.toolCallId === "string" ? update.event.toolCallId : [...this.#pending].findLast(([, call]) => call.type === "shell")?.[0];
        const value = update.event.value;
        if (id && this.#pending.get(id)?.type === "shell" && (update.event.case === "stdout" || update.event.case === "stderr") && typeof value === "object" && value !== null && "data" in value && typeof value.data === "string") {
          const output = (this.#shellOutput.get(id) ?? "") + value.data;
          this.#shellOutput.set(id, output.length > 512 * 1024 ? output.slice(-256 * 1024) : output);
        }
        break;
      }
    }
  }
  fallback(text: string | undefined) { if (!this.#seenText && text) this.text("assistant", text); }
  finalize(status: "completed" | "failed" | "interrupted") {
    this.flush();
    for (const [callId, call] of this.#pending) {
      const finalStatus = status === "interrupted" ? "interrupted" : "failed";
      if (call.type === "task") this.subagent(callId, call, finalStatus);
      this.tool(callId, call, finalStatus);
    }
    this.#pending.clear();
  }
  private subagent(callId: string, call: Extract<ToolCall, { type: "task" }>, status: "running" | "completed" | "failed" | "interrupted") {
    this.host.emit({ type: "subagent_update", turnId: this.turnId, subagentId: call.args.agentId ?? callId,
      status,
      title: call.args.description || null, progress: null });
  }
  private tool(callId: string, call: ToolCall, finalStatus?: "failed" | "interrupted") {
    const id = `${this.sessionId}:${this.turnId}:tool:${callId}`;
    const failed = call.result?.status === "error" || (call.type === "shell" && call.result?.status === "success" && call.result.value.exitCode !== 0) || (call.type === "mcp" && call.result?.status === "success" && call.result.value.isError);
    const base = this.base(id, callId, finalStatus ?? (failed ? "failed" : "completed"));
    let result: HelperItem;
    switch (call.type) {
      case "shell": {
        const value = call.result?.status === "success" ? call.result.value : undefined;
        const output = (value ? [value.stdout, value.stderr].filter(part => typeof part === "string" && part.length > 0).join("\n") : "") || (this.#shellOutput.get(callId) ?? "").slice(-256 * 1024);
        this.#shellOutput.delete(callId);
        result = item(base, "command_execution", { input: call.args.command, ...(output ? { output } : {}), ...(typeof value?.exitCode === "number" ? { exitCode: value.exitCode } : {}) }); break;
      }
      case "edit": case "write": case "delete": case "generateImage":
        result = item(base, "file_change", { fileName: call.type === "generateImage" ? call.args.filePath ?? "generated-image" : call.args.path,
          ...(call.type === "edit" && call.result?.status === "success" ? {
            ...(call.result.value.diffString === undefined ? {} : { diffStr: call.result.value.diffString }),
            ...(call.result.value.linesAdded === undefined ? {} : { additions: call.result.value.linesAdded }),
            ...(call.result.value.linesRemoved === undefined ? {} : { deletions: call.result.value.linesRemoved }),
          } : {}) }); break;
      case "createPlan": result = item(base, "proposed_plan", { planId: id, markdown: call.args.plan, streaming: false }); break;
      case "updateTodos": {
        const todos = call.result?.status === "success" ? call.result.value.todos : call.args.todos;
        const steps = todos.filter(t => t.status !== "cancelled" && t.content.trim()).map((t, i) => ({ id: `todo-${i + 1}`, text: t.content, status: t.status === "inProgress" ? "running" as const : t.status === "completed" ? "completed" as const : "pending" as const }));
        result = item(base, "todo_list", { planId: id, steps }); break;
      }
      case "task": result = item(base, "subagent", { subagentId: call.args.agentId ?? callId, origin: "provider_native", driver: "cursor", providerInstanceId: this.instanceId, childThreadId: null, prompt: call.args.prompt, result: call.result?.status === "success" ? call.result.value.resultSuffix ?? null : null }); break;
      default: {
        const name = call.type === "read" ? "Read" : call.type === "mcp" ? `mcp__${call.args.providerIdentifier ?? "mcp"}__${call.args.toolName ?? "unknown"}` : call.type;
        const output = call.result?.status === "success" && call.type === "mcp"
          ? { ...call.result.value, content: call.result.value.content?.map(part => part.image?.mimeType ? { type: "image", mimeType: part.image.mimeType, data: part.image.data } : part) }
          : call.result?.status === "success" ? call.result.value : undefined;
        result = item(base, "dynamic_tool", { toolName: name, input: (call.type === "mcp" ? call.args.args ?? {} : call.args) as never,
          ...(output === undefined ? {} : { output: output as never }) });
      }
    }
    this.emit(result, callId);
  }
}
