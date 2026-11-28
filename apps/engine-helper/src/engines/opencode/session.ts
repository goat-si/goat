import { randomBytes, randomUUID } from "node:crypto";
import type { Event, Part, PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2";
import type { EngineHost, EngineSession } from "../../engine.ts";
import { assistantMessage, item, reasoning, errorItem } from "../../items.ts";
import { HelperError, type EngineInput, type InitializeParams, type RequestAnswer, type TurnSettings, type TurnOutcome } from "../../protocol.ts";
import { goatRemoteMcpConfig } from "./goatMcpConfig.ts";
import { permissionRules, questionId } from "./permissions.ts";
import { projectTool } from "./project.ts";
import { safeHost } from "./redact.ts";
import { client, startServer, type Sdk, type Server } from "./runtime.ts";

type Client = ReturnType<typeof client>;
type Admission = { id: string; accepted: boolean; observed: boolean; idle: boolean; pending: boolean };
type Turn = { id: string; settings: TurnSettings; interrupted: boolean; controller: AbortController; admission: Admission; parts: Map<string, Part>; roles: Map<string, string>; emitted: Set<string>; todos?: Todo[]; overflow?: boolean };
type Pending = { type: "permission"; value: PermissionRequest } | { type: "question"; value: QuestionRequest };
let lastTime = 0, counter = 0;
// Adapted from promptAdmission.ts:9-27.
function messageId(): string {
  const now = Date.now(); counter = lastTime === now ? counter + 1 : 1; lastTime = now;
  const time = BigInt.asUintN(48, BigInt(now) * 0x1000n + BigInt(counter)).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(randomBytes(28), (n) => alphabet[n % alphabet.length]).join("")}`;
}
function parsedModel(model: string) {
  const split = model.indexOf("/");
  return split > 0 && split < model.length - 1 ? { providerID: model.slice(0, split), modelID: model.slice(split + 1) } : null;
}
function textOf(inputs: ReadonlyArray<EngineInput>) { return inputs.map((input) => input.text).filter(Boolean).join("\n"); }

export class OpenCodeSession implements EngineSession {
  readonly engineRef: string;
  private active: Turn | undefined;
  private closed = false;
  private first: boolean;
  private readonly requests = new Map<string, Pending>();
  private readonly childSessions = new Set<string>();
  private readonly abortEvents: AbortController;
  private readonly api: Client;
  private readonly server: Server;
  private readonly params: InitializeParams;
  private readonly host: EngineHost;
  private constructor(api: Client, server: Server, params: InitializeParams, host: EngineHost, ref: string, abortEvents: AbortController) {
    this.api = api; this.server = server; this.params = params; this.host = host; this.abortEvents = abortEvents;
    this.engineRef = ref; this.first = params.resume === null;
  }
  static async create(module: Sdk, params: InitializeParams, host: EngineHost): Promise<OpenCodeSession> {
    const server = await startServer(module, params.cwd, params.launch);
    try {
      const api = client(module, server, params.cwd);
      const abortEvents = new AbortController();
      const events = await api.event.subscribe(undefined, { signal: abortEvents.signal });
      if (params.mcp) await api.mcp.add({ name: "goat", config: goatRemoteMcpConfig(params.mcp.url, `Bearer ${params.mcp.bearerToken}`) }, { throwOnError: true });
      const response = params.resume
        ? await api.session.get({ sessionID: params.resume }, { throwOnError: true })
        : await api.session.create({ permission: permissionRules(params.runtimeMode) }, { throwOnError: true });
      if (!response.data?.id) throw new Error("session missing");
      if (params.resume) await api.session.update({ sessionID: response.data.id, permission: permissionRules(params.runtimeMode) }, { throwOnError: true });
      const session = new OpenCodeSession(api, server, params, safeHost(host, params), response.data.id, abortEvents);
      server.onExit(() => { if (!session.closed) session.broken("OpenCode server exited"); });
      void session.consume(events.stream);
      return session;
    } catch { await server.close(); throw new HelperError("start_failed", "OpenCode session initialization failed"); }
  }
  private broken(reason: string) {
    if (this.active) this.finish(this.active, { type: "failed", reason });
    this.host.fail(reason);
  }
  private async consume(stream: AsyncIterable<Event>) {
    try { for await (const event of stream) { if (this.closed) return; await this.route(event); } }
    catch { if (!this.closed) this.broken("OpenCode event stream failed"); return; }
    if (!this.closed) this.broken("OpenCode event stream ended");
  }
  private base(id: string, turn: Turn) { return { id, nativeId: id, turnId: turn.id, driver: "opencode", now: this.host.now() }; }
  private completed(turn: Turn, id: string, value: ReturnType<typeof item>) {
    if (turn.emitted.has(id)) return;
    turn.emitted.add(id); this.host.emit({ type: "item_completed", turnId: turn.id, item: value, locator: { turnId: turn.id, itemId: id } });
  }
  private finish(turn: Turn, outcome: TurnOutcome) {
    if (this.active !== turn) return;
    for (const part of turn.parts.values()) this.finishPart(turn, part);
    if (turn.todos) {
      const id = `${turn.id}:todo`;
      const steps = turn.todos.flatMap((t, i) => t.status === "cancelled" ? [] : [{ id: `${id}:${i + 1}`, text: t.content.trim() || `Todo ${i + 1}`, status: t.status === "completed" ? "completed" as const : t.status === "in_progress" ? "running" as const : "pending" as const }]);
      this.completed(turn, id, item(this.base(id, turn), "todo_list", { planId: id, steps }));
    }
    for (const key of this.requests.keys()) { this.requests.delete(key); this.host.emit({ type: "request_closed", key }); }
    this.active = undefined;
    this.host.emit({ type: "turn_finished", turnId: turn.id, outcome });
  }
  private finishPart(turn: Turn, part: Part) {
    if (turn.roles.get(part.messageID) === "user") return;
    const base = this.base(part.id, turn);
    if (part.type === "text") this.completed(turn, part.id, assistantMessage(base, part.text, part.messageID));
    else if (part.type === "reasoning") this.completed(turn, part.id, reasoning(base, part.text));
    else if (part.type === "tool" && part.tool.toLowerCase() !== "question" && (part.state.status === "completed" || part.state.status === "error")) this.completed(turn, part.id, projectTool(part, turn.id, this.host, turn.settings.modelSelection.instanceId));
  }
  private async admission(turn: Turn, signal: "accepted" | "observed" | "idle" | "completed") {
    const a = turn.admission; if (!a.pending || this.active !== turn) return;
    if (signal === "idle") { a.idle = true; return; }
    if (signal === "accepted" || signal === "completed") a.accepted = true;
    if (signal === "observed" || signal === "completed") a.observed = true;
    if (!a.accepted || !a.observed) return;
    if (!a.idle) { a.pending = false; return; }
    try {
      const result = await this.api.session.status({}, { throwOnError: true });
      if (this.active !== turn || turn.admission !== a) return;
      const status = result.data?.[this.engineRef];
      if (!status || status.type === "idle") { a.pending = false; this.finish(turn, turn.interrupted ? { type: "interrupted" } : turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" }); }
      else a.pending = false;
    } catch { /* Unknown status keeps admission open rather than falsely completing. */ }
  }
  private async route(event: Event) {
    const turn = this.active; if (!turn) return;
    const props = event.properties;
    if (event.type === "session.created" && event.properties.info.parentID && (event.properties.info.parentID === this.engineRef || this.childSessions.has(event.properties.info.parentID))) {
      this.childSessions.add(event.properties.info.id); return;
    }
    if ("sessionID" in props && typeof props.sessionID === "string" && props.sessionID !== this.engineRef) {
      if (!this.childSessions.has(props.sessionID)) return;
      if (event.type === "permission.asked") this.openRequest(turn, { type: "permission", value: event.properties });
      else if (event.type === "question.asked") this.openRequest(turn, { type: "question", value: event.properties });
      else if (event.type === "permission.replied" || event.type === "question.replied" || event.type === "question.rejected") {
        const key = event.properties.requestID; if (this.requests.delete(key)) this.host.emit({ type: "request_closed", key });
      }
      return;
    }
    switch (event.type) {
      case "message.updated": {
        const msg = event.properties.info; turn.roles.set(msg.id, msg.role);
        if (msg.role === "user" && msg.id === turn.admission.id) await this.admission(turn, "observed");
        if (msg.role === "assistant" && msg.time.completed !== undefined) {
          await this.admission(turn, "completed");
          for (const part of turn.parts.values()) if (part.messageID === msg.id) this.finishPart(turn, part);
        }
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part; const old = turn.parts.get(part.id); turn.parts.set(part.id, part);
        if (part.type === "text" && turn.roles.get(part.messageID) !== "user") {
          const before = old?.type === "text" ? old.text : "";
          if (part.text.startsWith(before) && part.text.length > before.length) this.host.emit({ type: "text_delta", turnId: turn.id, itemId: part.id, text: part.text.slice(before.length) });
        }
        if (part.type === "tool" && part.tool.toLowerCase() === "task") {
          const meta = "metadata" in part.state ? part.state.metadata : undefined;
          const child = meta && typeof meta.sessionId === "string" ? meta.sessionId : part.id;
          if (child !== part.id) this.childSessions.add(child);
          const status = part.state.status === "completed" ? "completed" : part.state.status === "error" ? "failed" : "running";
          this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: child, status, title: "title" in part.state ? part.state.title : null, progress: null });
        }
        if (part.type === "tool" && part.tool.toLowerCase() !== "question") this.finishPart(turn, part);
        return;
      }
      case "message.part.delta": {
        const p = event.properties; const part = turn.parts.get(p.partID);
        if (p.field === "text" && part && (part.type === "text" || part.type === "reasoning")) {
          turn.parts.set(part.id, { ...part, text: part.text + p.delta });
          if (part.type === "text" && turn.roles.get(part.messageID) !== "user") this.host.emit({ type: "text_delta", turnId: turn.id, itemId: part.id, text: p.delta });
        }
        return;
      }
      case "session.status":
        if (event.properties.status.type === "idle") { if (turn.admission.pending) await this.admission(turn, "idle"); else this.finish(turn, turn.interrupted ? { type: "interrupted" } : turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" }); }
        else await this.admission(turn, "observed");
        return;
      case "session.idle":
        if (turn.admission.pending) await this.admission(turn, "idle"); else this.finish(turn, turn.interrupted ? { type: "interrupted" } : turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" });
        return;
      case "session.compacted": turn.overflow = false; return;
      case "session.error": {
        if (event.properties.error?.name === "ContextOverflowError") { turn.overflow = true; return; }
        const auth = event.properties.error?.name === "ProviderAuthError";
        if (auth) this.host.emit({ type: "auth_required", turnId: turn.id, url: null, message: "OpenCode provider sign-in required" });
        const message = auth ? "OpenCode provider sign-in required" : "OpenCode turn failed";
        const usage = event.properties.error?.name === "APIError" && event.properties.error.data.statusCode === 429;
        const id = `${turn.id}:error`; this.completed(turn, id, errorItem(this.base(id, turn), message, usage ? "usage_limit" : "provider_error"));
        this.finish(turn, { type: "failed", reason: message }); return;
      }
      case "permission.asked": this.openRequest(turn, { type: "permission", value: event.properties }); return;
      case "question.asked": this.openRequest(turn, { type: "question", value: event.properties }); return;
      case "permission.replied": case "question.replied": case "question.rejected": {
        const key = event.properties.requestID; if (this.requests.delete(key)) this.host.emit({ type: "request_closed", key }); return;
      }
      case "todo.updated": {
        turn.todos = event.properties.todos; return;
      }
    }
  }
  private openRequest(turn: Turn, request: Pending) {
    const key = request.value.id; if (this.requests.has(key)) return;
    this.requests.set(key, request);
    const base = { ...this.base(key, turn), status: "waiting" as const, completedAt: null };
    if (request.type === "question") {
      const questions = request.value.questions.map((q, i) => ({ id: questionId(i, q), header: q.header.trim() || `Question ${i + 1}`, question: q.question.trim() || q.header.trim() || `Question ${i + 1}`, options: q.options, ...(q.multiple === undefined ? {} : { multiSelect: q.multiple }), ...(q.custom === undefined ? {} : { allowCustomAnswer: q.custom }) }));
      this.host.emit({ type: "request_opened", turnId: turn.id, key, itemId: key, kind: "question", summary: "OpenCode question", item: item(base, "user_input_request", { requestId: key, questions }) });
    } else {
      const permission = request.value.permission.toLowerCase();
      const kind = ["edit", "write", "patch", "apply_patch"].includes(permission) ? "file-change" : ["read", "glob", "grep", "lsp", "external_directory"].includes(permission) ? "file-read" : "command";
      this.host.emit({ type: "request_opened", turnId: turn.id, key, itemId: key, kind: "approval", summary: `OpenCode ${permission} approval`, item: item(base, "approval_request", { requestId: key, requestKind: kind }) });
    }
  }
  private async submit(turn: Turn, inputs: ReadonlyArray<EngineInput>, preamble: boolean) {
    const model = parsedModel(turn.settings.modelSelection.model); if (!model) throw new HelperError("bad_request", "OpenCode model must use provider/model format");
    if (inputs.some((input) => input.attachments.length)) throw new HelperError("bad_request", "OpenCode attachments cannot be resolved by this helper");
    const text = [preamble ? this.params.instructions?.firstMessagePreamble : null, textOf(inputs)].filter(Boolean).join("\n\n");
    if (!text.trim()) throw new HelperError("bad_request", "OpenCode prompt requires text");
    const options = turn.settings.modelSelection.options ?? [];
    const agent = options.find((o) => o.id === "agent")?.value;
    const variant = options.find((o) => o.id === "variant")?.value;
    await this.api.session.promptAsync({ sessionID: this.engineRef, messageID: turn.admission.id, model, parts: [{ type: "text", text }],
      ...(this.params.instructions?.appendSystemPrompt ? { system: this.params.instructions.appendSystemPrompt } : {}),
      ...(typeof agent === "string" ? { agent } : {}), ...(typeof variant === "string" && variant !== "goat:default" ? { variant } : {}) }, { throwOnError: true, signal: turn.controller.signal });
    await this.admission(turn, "accepted");
  }
  async startTurn(inputs: ReadonlyArray<EngineInput>, settings: TurnSettings) {
    if (this.active) return { status: "declined" as const, reason: "a turn is already running" };
    if (settings.runtimeMode !== this.params.runtimeMode) return { status: "declined" as const, reason: "OpenCode cannot switch runtime mode in a session" };
    try {
      const state = await this.api.session.status({}, { throwOnError: true });
      if (state.data?.[this.engineRef] && state.data[this.engineRef]?.type !== "idle") return { status: "refused_unowned" as const, reason: "OpenCode session has an unowned active turn" };
    } catch { return { status: "unknown" as const, reason: "OpenCode session status could not be checked" }; }
    if (this.active) return { status: "declined" as const, reason: "a turn is already running" };
    if (!parsedModel(settings.modelSelection.model)) return { status: "declined" as const, reason: "OpenCode model must use provider/model format" };
    if (!textOf(inputs).trim() || inputs.some((input) => input.attachments.length)) return { status: "declined" as const, reason: "OpenCode requires text without unresolved attachments" };
    const turn: Turn = { id: `${this.engineRef}:attempt:${randomUUID()}`, settings, interrupted: false, controller: new AbortController(), admission: { id: messageId(), accepted: false, observed: false, idle: false, pending: true }, parts: new Map(), roles: new Map(), emitted: new Set() };
    this.active = turn;
    const first = this.first; this.first = false;
    // The response must be sent before the event can settle the accepted turn.
    setImmediate(() => {
      if (this.active !== turn || turn.interrupted) return;
      void this.submit(turn, inputs, first).catch(() => this.finish(turn, turn.interrupted ? { type: "interrupted" } : { type: "failed", reason: "OpenCode prompt submission failed" }));
    });
    return { status: "accepted" as const, turnId: turn.id };
  }
  async steer(turnId: string, inputs: ReadonlyArray<EngineInput>) {
    const turn = this.active;
    if (!turn || turn.id !== turnId || turn.interrupted || turn.admission.pending || !textOf(inputs).trim() || inputs.some((i) => i.attachments.length)) return { status: "declined" as const, reason: "OpenCode turn is not available for steering" };
    turn.admission = { id: messageId(), accepted: false, observed: false, idle: false, pending: true };
    try { await this.submit(turn, inputs, false); return { status: "accepted" as const }; }
    catch { return { status: "unknown" as const, reason: "OpenCode steering admission could not be confirmed" }; }
  }
  async interrupt(turnId: string) {
    const turn = this.active; if (!turn || turn.id !== turnId) return;
    turn.interrupted = true;
    turn.controller.abort();
    try { await this.api.session.abort({ sessionID: this.engineRef }, { throwOnError: true }); }
    catch { throw new HelperError("transport", "OpenCode interrupt failed"); }
    if (this.active === turn && turn.admission.pending) { turn.admission.pending = false; this.finish(turn, { type: "interrupted" }); }
  }
  async answerRequest(key: string, answer: RequestAnswer) {
    const request = this.requests.get(key); if (!request) throw new HelperError("bad_request", "No open OpenCode request");
    try {
      if (request.type === "permission") {
        const reply = answer.outcome === "accept" ? "once" : answer.outcome === "acceptAlways" || answer.outcome === "acceptForSession" ? "always" : "reject";
        await this.api.permission.reply({ requestID: key, reply }, { throwOnError: true });
      } else if (answer.outcome === "cancel" || answer.outcome === "decline") {
        await this.api.question.reject({ requestID: key }, { throwOnError: true });
      } else {
        if (!answer.answers && !answer.text) throw new HelperError("bad_request", "OpenCode question requires answers");
        const values = answer.answers ?? {};
        const answers = request.value.questions.map((q, i) => { const raw = values[questionId(i, q)] ?? values[q.header] ?? values[q.question] ?? (i === 0 ? answer.text : undefined); return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : typeof raw === "string" && raw.trim() ? [raw] : []; });
        await this.api.question.reply({ requestID: key, answers }, { throwOnError: true });
      }
    } catch (error) { if (error instanceof HelperError) throw error; throw new HelperError("transport", "OpenCode request response failed"); }
    if (this.requests.delete(key)) this.host.emit({ type: "request_closed", key });
  }
  async shutdown() { this.closed = true; if (this.active) { this.active.controller.abort(); this.finish(this.active, { type: "interrupted" }); } this.abortEvents.abort(); await this.server.close(); }
}
