import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EngineHost, EngineModule, EngineSession } from "../../engine.ts";
import { errorItem, item } from "../../items.ts";
import { HelperError, type EngineInput, type InitializeParams, type RequestAnswer, type TurnSettings, type TurnStartResult, type SteerResult, type ProbeParams, type ProbeResult } from "../../protocol.ts";
import { createMuseHost, museEnvironment } from "./sdk.ts";
import { projectMuseItem } from "./presentation.ts";

type Native = Record<string, any>;
type Host = Awaited<ReturnType<typeof createMuseHost>>;
type Active = { id: string; interrupted: boolean; admitted: boolean; draining: boolean; queue: Array<[string, Native]>; items: Map<string, Native>; completed: Set<string>; joined: Set<string>; done: Promise<void>; finish: () => void; retries: Map<string, { attempt: number; maxAttempts: number | null; retryDelayMs: number | null }> };
const environment = (params: InitializeParams | ProbeParams) => ({ ...process.env, ...params.launch?.env });
const launchOptions = (params: InitializeParams | ProbeParams) => ({ binary: params.launch?.binary || "muse", ...(params.launch?.args ? { args: params.launch.args } : {}), ...(params.cwd ? { cwd: params.cwd } : {}), env: environment(params) });
const textInput = (inputs: readonly EngineInput[]) => inputs.map((input) => input.text).join("\n");
const parts = (inputs: readonly EngineInput[]) => inputs.map((input) => ({ type: "text", text: input.text }));
async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Muse operation timed out")), ms);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const unsupportedAttachments = (inputs: readonly EngineInput[]) => inputs.some((input) => input.attachments.length > 0);

// Adapted from adapter.ts:250-299, 1255-1460 and museInbox.ts:11-48 at 916b5ccc1b2.
class MuseSession implements EngineSession {
  readonly engineRef: string;
  private active: Active | undefined;
  private closed = false;
  private starting = false;
  private uncertain = false;
  private pending = new Map<string, Native>();
  private first: boolean;
  private model: string;
  private readonly secrets: string[];
  private readonly deltaTails = new Map<string, string>();
  private readonly deltaKinds = new Map<string, "assistant_text" | "reasoning_text" | "command_output">();
  private readonly native: Host;
  private readonly params: InitializeParams;
  private readonly host: EngineHost;
  constructor(native: Host, params: InitializeParams, host: EngineHost, id: string) {
    this.native = native;
    this.params = params;
    this.secrets = [...new Set([params.mcp?.bearerToken, ...Object.entries(environment(params)).filter(([key]) => /(?:token|secret|password|api.?key|credential|authorization)/i.test(key)).map(([, value]) => value)].filter((value): value is string => typeof value === "string" && value.length >= 4))];
    const clean = (value: any, key = ""): any => {
      if (typeof value === "string") return this.redact(value);
      if (Array.isArray(value)) return value.map((entry) => clean(entry));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, /^(?:api.?key|password|secret|access.?token|bearer.?token|authorization)$/i.test(name) ? "[redacted]" : clean(entry, name)]));
      return value;
    };
    this.host = { ...host, emit: (event) => host.emit(clean(event)) };
    this.engineRef = id;
    this.first = params.resume === null;
    this.model = params.modelSelection.model;
    const connection = native.host.connection;
    connection.onNotification(({ method, params }) => this.notify(method, params ?? {}));
    connection.onProtocolError(() => this.fail("Muse protocol error"));
    connection.onServerRequest(async (request) => {
      if (request.method === "approval/request" || request.method === "userInput/request") return {};
      throw new Error("Unsupported Muse server request");
    });
    void connection.closed.then(() => this.fail("Muse connection closed"), () => this.fail("Muse connection closed"));
    void native.host.exited.then(() => this.fail("Muse process exited"), () => this.fail("Muse process exited"));
  }
  private redact(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join("[redacted]");
    return value;
  }
  // Hold a suffix that could be the beginning of a credential split across deltas.
  private delta(turn: Active, id: string, text: string, final = false, kind: "assistant_text" | "reasoning_text" | "command_output" = "assistant_text") {
    const key = `${turn.id}:${id}`;
    if (!final && this.deltaKinds.has(key) && this.deltaKinds.get(key) !== kind) return;
    if (!final) this.deltaKinds.set(key, kind);
    kind = this.deltaKinds.get(key) ?? kind;
    let value = this.redact((this.deltaTails.get(key) ?? "") + text);
    let hold = 0;
    if (!final) for (const secret of this.secrets) {
      for (let n = Math.min(secret.length - 1, value.length); n > hold; n--) {
        if (value.endsWith(secret.slice(0, n))) { hold = n; break; }
      }
    }
    if (final) { this.deltaTails.delete(key); this.deltaKinds.delete(key); }
    else this.deltaTails.set(key, hold ? value.slice(-hold) : "");
    value = hold ? value.slice(0, -hold) : value;
    if (value) {
      if (kind === "assistant_text") this.host.emit({ type: "text_delta", turnId: turn.id, itemId: key, text: value });
      else this.host.emit({ type: "content_delta", turnId: turn.id, itemId: key, streamKind: kind, text: value });
    }
  }
  private fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const turn = this.active;
    this.active = undefined;
    turn?.finish();
    for (const key of this.pending.keys()) { this.pending.delete(key); this.host.emit({ type: "request_closed", key }); }
    if (turn?.admitted) this.host.emit({ type: "turn_finished", turnId: turn.id, outcome: { type: "failed", reason } });
    this.host.fail(reason);
    void this.native.close().catch(() => {});
  }
  private async command(method: string, params: Native, commandId?: string) {
    try {
      return await deadline(this.native.host.connection.command(method, { sessionId: this.engineRef, ...params }, { ...(method === "turn/start" ? {} : { maxAttempts: 1 }), ...(commandId ? { commandId } : {}) }), 30_000);
    } catch (error) {
      if (error instanceof Error && error.message === "Muse operation timed out") this.fail("Muse request timed out");
      throw error;
    }
  }
  private emitItem(turn: Active, native: Native) {
    if (typeof native.itemId !== "string") return;
    const id = `${turn.id}:${native.itemId}`;
    if (turn.completed.has(id)) return;
    turn.completed.add(id);
    const value = projectMuseItem(native, turn.id, id, this.host.now(), this.params.modelSelection.instanceId);
    if (value) this.host.emit({ type: "item_completed", turnId: turn.id, item: value, locator: { turnId: turn.id, itemId: native.itemId } });
  }
  private notify(method: string, p: Native) {
    if (p.sessionId !== this.engineRef) return;
    if (method === "view/gap") return this.fail("Muse delivery gap requires session recovery");
    if (method === "session/closed") return this.fail("Muse session closed");
    const turn = this.active;
    if (!turn) {
      // The helper protocol cannot represent v1 runless approvals or wake offers.
      if ((method === "approval/requested" && p.subagentOrigin !== undefined) || method === "turn/started") this.fail("Muse background work requires unsupported host coordination");
      return;
    }
    if (!turn.admitted || turn.draining) { if (turn.queue.length >= 2048) return this.fail("Muse event inbox exceeded capacity"); turn.queue.push([method, p]); return; }
    const id = p.turnId ?? p.item?.turnId;
    if (method === "turn/started" && typeof id === "string" && id !== turn.id) turn.joined.add(id);
    if (typeof id === "string" && id !== turn.id && !turn.joined.has(id) && !(method.startsWith("approval/") && p.subagentOrigin !== undefined)) return;
    if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      const native = p.item;
      if (!native || typeof native.itemId !== "string") return;
      const previous = turn.items.get(native.itemId);
      if (previous && previous.revision >= native.revision) return;
      turn.items.set(native.itemId, native);
      if (native.status !== "inProgress") this.delta(turn, native.itemId, "", true);
      if (native.kind === "subagent") this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: native.subagentId ?? native.itemId, status: native.status === "inProgress" ? "running" : native.status === "completed" ? "completed" : native.status === "cancelled" ? "cancelled" : "failed", title: native.objective ?? native.role ?? "Muse agent", progress: native.result?.summary ?? null });
      if (method === "item/completed" || (native.status !== "inProgress" && method === "item/updated")) this.emitItem(turn, native);
    } else if (method === "item/delta") {
      const native = turn.items.get(p.itemId);
      if (!native || native.status !== "inProgress" || typeof p.delta !== "string") return;
      const field = p.field ?? "text";
      if (field === "text") native.text = (native.text ?? "") + p.delta;
      else if (field === "output" || field === "visibleOutput") native.visibleOutput = (native.visibleOutput ?? "") + p.delta;
      else if (/^summary\.(?:0|[1-9]\d?)$/.test(field)) {
        const index = Number(field.slice(8));
        native.summary ??= [];
        native.summary[index] = (native.summary[index] ?? "") + p.delta;
      } else return;
      if (native.kind === "agentMessage" && field === "text") this.delta(turn, native.itemId, p.delta);
      else if (native.kind === "reasoning" && (field === "text" || field.startsWith("summary."))) this.delta(turn, native.itemId, p.delta, false, "reasoning_text");
      else if ((native.kind === "userShell" || /shell|bash|exec_command/i.test(native.tool ?? "")) && (field === "output" || field === "visibleOutput" || field === "text")) this.delta(turn, native.itemId, p.delta, false, "command_output");
    } else if (method === "turn/completed" && p.turnId === turn.id) {
      this.active = undefined;
      turn.finish();
      for (const native of turn.items.values()) if (native.status === "inProgress") {
        this.delta(turn, native.itemId, "", true);
        this.emitItem(turn, { ...native, status: p.terminal === "completed" ? "completed" : "cancelled" });
      }
      for (const [id, retry] of turn.retries) {
        const failure = errorItem({ id: `${turn.id}:${id}`, turnId: turn.id, driver: "muse", now: this.host.now(), status: p.terminal === "completed" ? "completed" : "interrupted" }, "Muse model request retried");
        if (failure.type === "error") this.host.emit({ type: "item_completed", turnId: turn.id, item: { ...failure, retry }, locator: null });
      }
      const outcome = p.terminal === "completed" ? { type: "done" as const } : p.terminal === "cancelled" && turn.interrupted ? { type: "interrupted" as const } : { type: "failed" as const, reason: "Muse turn failed" };
      if (outcome.type === "failed") {
        const detail = String(p.error?.message ?? p.reason ?? "");
        const auth = /auth|login|sign.?in|unauthor/i.test(detail);
        const limited = p.error?.quota !== undefined || /quota|usage.limit|rate.limit/i.test(detail);
        if (auth) this.host.emit({ type: "auth_required", turnId: turn.id, url: null, message: "Muse requires sign-in" });
        const failure = errorItem({ id: `${turn.id}:failure`, turnId: turn.id, driver: "muse", now: this.host.now(), status: "failed" }, "Muse turn failed", limited ? "usage_limit" : "provider_error");
        this.host.emit({ type: "item_completed", turnId: turn.id, item: failure, locator: null });
      }
      for (const key of this.pending.keys()) { this.pending.delete(key); this.host.emit({ type: "request_closed", key }); }
      this.host.emit({ type: "turn_finished", turnId: turn.id, outcome });
    } else if ((method === "turn/retryScheduled" || method === "turn/modelRetryScheduled") && typeof p.attempt === "number") {
      // retryRows.ts: Muse counts the first request as attempt one.
      const source = p.attempt > 1 ? [...turn.retries.keys()].findLast((key) => key.startsWith(`${method}:`)) : undefined;
      const key = source ?? `${method}:${p.sourceRange?.first?.id ?? turn.retries.size}`;
      turn.retries.set(key, { attempt: p.attempt, maxAttempts: typeof p.maxAttempts === "number" ? Math.max(1, p.maxAttempts - 1) : null, retryDelayMs: typeof p.retryDelayMs === "number" ? Math.trunc(p.retryDelayMs) : null });
    } else if (method === "approval/requested" || method === "approval/updated" || method === "userInput/requested") {
      this.openRequest(turn, method, p);
    } else if (method === "approval/resolved" || method === "userInput/settled") {
      const key = `${method.startsWith("approval") ? "approval" : "question"}:${method.startsWith("approval") ? p.approvalId : p.userInputId}`;
      if (this.pending.delete(key)) this.host.emit({ type: "request_closed", key });
    } else if (method === "session/todoListChanged" && Array.isArray(p.items)) {
      const key = `${turn.id}:todo`;
      const steps = p.items.filter((v: Native) => typeof v.text === "string" && v.text.trim() && v.status !== "cancelled").map((v: Native, i: number) => ({ id: `${key}:${i}`, text: v.text.trim(), status: v.status === "completed" ? "completed" as const : v.status === "inProgress" ? "running" as const : "pending" as const }));
      const value = item({ id: key, turnId: turn.id, driver: "muse", now: this.host.now() }, "todo_list", { planId: key, steps });
      this.host.emit({ type: "item_completed", turnId: turn.id, item: value, locator: { turnId: turn.id, itemId: "todo" } });
    }
  }
  // Approval choices and question conversion follow adapter.ts:1026-1247, 2226-2290.
  private openRequest(turn: Active, method: string, p: Native) {
    const approval = method.startsWith("approval");
    const id = approval ? p.approvalId : p.userInputId;
    if (typeof id !== "string") return;
    const key = `${approval ? "approval" : "question"}:${id}`;
    if (method === "approval/updated" && !this.pending.has(key)) return;
    this.pending.set(key, p);
    const base = { id: `${turn.id}:request:${key}`, turnId: turn.id, driver: "muse", nativeId: id, status: "waiting" as const, completedAt: null, now: this.host.now() };
    const subject = p.subject ?? {};
    const prompt = subject.command ?? subject.path ?? subject.host ?? subject.target ?? p.toolName ?? "Muse requests permission";
    const kind = subject.kind === "shell" ? "command" : subject.kind === "fileAccess" ? subject.access === "read" ? "file-read" : "file-change" : "permission";
    const value = approval ? item(base, "approval_request", { requestId: key, requestKind: kind, prompt }) : item(base, "user_input_request", { requestId: key, questions: (p.questions ?? []).map((q: Native) => ({ id: q.id, header: q.header || "Question", question: q.question, options: (q.options ?? []).map((o: Native) => ({ label: o.label, description: o.description || o.label })), multiSelect: q.selection?.mode === "multiple", allowCustomAnswer: true, required: true })) });
    this.host.emit({ type: "request_opened", turnId: turn.id, key, itemId: base.id, kind: approval ? "approval" : "question", summary: approval ? prompt : "Muse asks a question", item: value });
  }
  async startTurn(inputs: readonly EngineInput[], settings: TurnSettings): Promise<TurnStartResult> {
    if (this.closed) return { status: "declined", reason: "Muse host is closed" };
    if (this.uncertain) return { status: "declined", reason: "Muse turn admission requires session recovery" };
    if (this.active || this.starting) return { status: "declined", reason: "Muse already has an active turn" };
    if (unsupportedAttachments(inputs)) return { status: "declined", reason: "Muse helper cannot resolve attachment blobs" };
    if (!inputs.some((input) => input.text.length > 0)) return { status: "declined", reason: "Muse needs text or an image" };
    if (settings.modelSelection.instanceId !== this.params.modelSelection.instanceId) return { status: "declined", reason: "Model selection belongs to another Muse instance" };
    if (settings.runtimeMode !== this.params.runtimeMode) return { status: "declined", reason: "Runtime mode changes require a fresh Muse host" };
    this.starting = true;
    try {
      if (settings.modelSelection.model !== this.model) { await this.command("session/setModel", { model: { modelId: settings.modelSelection.model, providerId: "meta" } }); this.model = settings.modelSelection.model; }
      const id = this.native.host.connection.mintCommandId();
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const turn: Active = { id, interrupted: false, admitted: false, draining: true, queue: [], items: new Map(), completed: new Set(), joined: new Set(), done, finish, retries: new Map() };
      this.active = turn;
      const preamble = this.first ? [this.params.instructions?.appendSystemPrompt, this.params.instructions?.firstMessagePreamble].filter(Boolean).join("\n\n") : "";
      const content = parts(inputs);
      if (preamble) content.unshift({ type: "text", text: preamble });
      const effort = settings.modelSelection.options?.find((option) => option.id === "reasoningEffort")?.value;
      const result = await this.command("turn/start", { input: content, displayText: textInput(inputs) || "Image attachment", workspaceRoots: [this.params.cwd], ifBusy: "queue", ...(typeof effort === "string" ? { reasoningEffort: effort } : {}) }, id);
      if (result.turnId !== id) { this.fail("Muse admitted an unowned turn"); return { status: "unknown", reason: "Muse admitted an unowned turn" }; }
      if (this.closed || this.active !== turn) return { status: "unknown", reason: "Muse host exited during turn admission" };
      this.first = false;
      turn.admitted = true;
      setImmediate(() => { if (this.active !== turn) return; turn.draining = false; for (const [method, params] of turn.queue.splice(0)) this.notify(method, params); });
      return { status: "accepted", turnId: id };
    } catch (error) {
      const attempted = this.active !== undefined;
      this.active = undefined;
      if (/auth|login|sign.?in|unauthor/i.test(error instanceof Error ? error.message : "")) this.host.emit({ type: "auth_required", turnId: null, url: null, message: "Muse requires sign-in" });
      const kind = (error as { kind?: unknown } | null)?.kind;
      const refused = !attempted || ["commandRejected", "invalidParams", "inputTooLarge", "backpressured"].includes(String(kind));
      if (!refused) this.uncertain = true;
      return { status: refused ? "declined" : "unknown", reason: refused ? "Muse could not start the turn" : "Muse turn admission is unknown" };
    } finally { this.starting = false; }
  }
  async steer(turnId: string, inputs: readonly EngineInput[]): Promise<SteerResult> {
    if (!this.active || this.active.id !== turnId || unsupportedAttachments(inputs)) return { status: "declined", reason: "This Muse turn cannot be steered" };
    try {
      const result = await this.command("turn/steer", { expectedTurnId: turnId, input: parts(inputs) });
      if (result.turnId !== turnId) return { status: "unknown", reason: "Muse steering targeted a different turn" };
      // MSP turn/steer answers once the input is in the running turn, so it is read on acceptance;
      // the goat2 contract wants every accepted steer settled before that turn's turn_finished.
      this.host.emit({ type: "steer_updated", turnId, inputIds: inputs.map((input) => input.inputId), status: { type: "completed" } });
      return { status: "accepted" };
    }
    catch (error) {
      const kind = (error as { kind?: unknown } | null)?.kind;
      const refused = ["commandRejected", "invalidParams", "inputTooLarge", "backpressured"].includes(String(kind));
      return { status: refused ? "declined" : "unknown", reason: refused ? "Muse declined steering" : "Muse steering outcome is unknown" };
    }
  }
  async interrupt(turnId: string): Promise<void> {
    const turn = this.active;
    if (!turn || turn.id !== turnId) return;
    turn.interrupted = true;
    try {
      for (const id of turn.joined) await this.command("turn/interrupt", { turnId: id }).catch(() => {});
      await this.command("turn/interrupt", { turnId });
      await deadline(turn.done, 30_000);
    } catch {
      this.fail("Muse did not confirm interruption");
      throw new HelperError("transport", "Muse could not interrupt the turn");
    }
  }
  async answerRequest(key: string, answer: RequestAnswer): Promise<void> {
    const request = this.pending.get(key);
    if (!request) throw new HelperError("bad_request", "Muse request is no longer pending");
    try {
      if (key.startsWith("approval:")) {
        const mapping: Record<string, string[]> = { accept: ["approved"], acceptForSession: ["approvedForSession", "approvedPolicyAmendment"], acceptAlways: ["approvedPolicyAmendment"], decline: ["denied", "deniedPolicyAmendment", "abort"], cancel: ["abort"] };
        const choices = (request.availableChoices ?? []).filter((choice: Native) => mapping[answer.outcome]?.includes(choice.decision)).filter((choice: Native) => choice.decision !== "approvedPolicyAmendment" || (answer.outcome === "acceptForSession" ? choice.scope === "session" : choice.scope === "localPersistent"));
        choices.sort((a: Native, b: Native) => (a.scope === "once" ? 0 : a.scope === "session" ? 2 : 4) - (b.scope === "once" ? 0 : b.scope === "session" ? 2 : 4));
        if (!choices.length) throw new HelperError("bad_request", "Muse did not offer this approval decision");
        await this.command("approval/decide", { approvalId: request.approvalId, requirementId: request.currentRequirementId, choiceId: choices[0].choiceId });
      } else {
        const answers = (request.questions ?? []).map((q: Native) => {
          const raw = answer.answers?.[q.id] ?? answer.text;
          const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? [...new Set(raw)].filter((v): v is string => typeof v === "string") : [];
          const selected = values.filter((v) => q.options?.some((o: Native) => o.label === v));
          const free = values.filter((v) => !selected.includes(v)).join("\n");
          if ((!selected.length && !free) || free.length > 500 || (q.selection?.mode === "single" && selected.length > 1) || (selected.length > 0 && (selected.length < (q.selection?.minSelections ?? 0) || selected.length > (q.selection?.maxSelections ?? Infinity)))) throw new HelperError("bad_request", "Muse question answer is invalid");
          return { questionId: q.id, ...(selected.length ? q.selection?.mode === "single" ? { selectedLabel: selected[0] } : { selectedLabels: selected } : {}), ...(free ? selected.length ? { note: free } : { freeText: free } : {}) };
        });
        await this.command("userInput/answer", { userInputId: request.userInputId, answers });
      }
    } catch (error) { if (error instanceof HelperError) throw error; throw new HelperError("transport", "Muse could not answer the request"); }
  }
  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    const turn = this.active;
    this.active = undefined;
    turn?.finish();
    for (const key of this.pending.keys()) { this.pending.delete(key); this.host.emit({ type: "request_closed", key }); }
    if (turn?.admitted) this.host.emit({ type: "turn_finished", turnId: turn.id, outcome: { type: "interrupted" } });
    await this.native.close();
  }
}

// Session identity and MCP configuration: adapter.ts:1756-1813.
async function start(params: InitializeParams, host: EngineHost): Promise<EngineSession> {
  let native: Host | undefined;
  try {
    native = await createMuseHost({ ...launchOptions(params), fullAccess: params.runtimeMode === "full-access" });
    const connection = native.host.connection;
    if (params.mcp && !native.host.initializeResult.grantedCapabilities.includes("sessionMcp")) throw new Error("missing session MCP");
    const id = params.resume ?? connection.mintCommandId();
    const config = params.mcp ? { mcpServers: { goat: { transport: "streamableHttp", mode: "optional", url: params.mcp.url, headers: { Authorization: `Bearer ${params.mcp.bearerToken}` } } } } : undefined;
    const profile = params.runtimeMode === "full-access" ? ":unrestricted" : ":ask-me";
    const mode = params.runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
    const result = await deadline(connection.command(params.resume ? "session/resume" : "session/start", { sessionId: id, ...(params.resume ? { excludeItems: true, ...(config ? { config } : {}), permissionProfile: profile } : { workspaceRoot: params.cwd, ...(config ? { config } : {}), modelId: params.modelSelection.model, providerId: "meta", approvalMode: mode, permissionProfile: profile }) }, { maxAttempts: 1 }), 30_000);
    const session = result.session as Native | undefined;
    if (session?.sessionId !== id || (result.history as Native | undefined)?.noneReason === "projectionUnavailable") throw new Error("invalid session");
    if (params.resume) await deadline(connection.command("session/setApprovalMode", { sessionId: id, mode }, { maxAttempts: 1 }), 30_000);
    return new MuseSession(native, params, host, id);
  } catch (error) {
    await native?.close().catch(() => {});
    if (/auth|login|sign.?in|unauthor/i.test(error instanceof Error ? error.message : "")) host.emit({ type: "auth_required", turnId: null, url: null, message: "Muse requires sign-in" });
    throw new HelperError("start_failed", "Muse could not start or resume the session");
  }
}

// status.ts:76-178: version check then read-only model/list, with auth unknown.
async function probe(params: ProbeParams, host: EngineHost): Promise<ProbeResult> {
  const base = { installed: false, version: null as string | null, auth: { status: "unknown" as const }, models: [], checkedAt: host.now() };
  const options = launchOptions(params);
  let version: string | null = null;
  try {
    const result = await promisify(execFile)(options.binary, [...(options.args ?? []), "--version"], { cwd: options.cwd, env: museEnvironment(options.env), timeout: 8000, maxBuffer: 65536 });
    version = result.stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null;
  } catch (error) { const missing = (error as NodeJS.ErrnoException).code === "ENOENT"; return { ...base, installed: !missing, status: "error", message: missing ? "Muse CLI was not found" : "Muse CLI version check failed" }; }
  let native: Host | undefined;
  try {
    native = await createMuseHost({ ...options, readOnly: true, timeoutMs: 8000 });
    const result = await deadline(native.host.connection.request("model/list", {}), 4_000);
    if (result.providerId !== "meta" || !Array.isArray(result.models)) throw new Error("invalid catalog");
    const seen = new Set<string>();
    const labels: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
    const models = result.models.flatMap((m: Native) => {
      if (m.providerId !== "meta" || typeof m.modelId !== "string" || seen.has(m.modelId)) return [];
      seen.add(m.modelId);
      const label = typeof m.displayLabel === "string" && m.displayLabel.trim() || m.modelId;
      const name = label === m.modelId && label.startsWith("muse-") ? label.replaceAll("-", " ").replace(/\b[a-z]/g, (s: string) => s.toUpperCase()) : label;
      const efforts = (Array.isArray(m.variants) ? m.variants : ["low", "medium", "high", "xhigh", "max"]).filter((s: string) => Object.hasOwn(labels, s));
      const current = efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : Array.isArray(m.variants) ? efforts[0] : "high";
      return [{ slug: m.modelId, name, isDefault: m.isDefault === true, isCustom: false, capabilities: { optionDescriptors: current ? [{ type: "select" as const, id: "reasoningEffort", label: "Reasoning", currentValue: current, options: efforts.map((id: string) => ({ id, label: labels[id]!, ...(id === current ? { isDefault: true } : {}), ...(m.reasoningEffortVariants?.find((v: Native) => v.tier === id)?.description ? { description: m.reasoningEffortVariants.find((v: Native) => v.tier === id).description } : {}) })) }] : [] } }];
    });
    return { ...base, installed: true, version, status: models.length ? "ready" : "warning", models, ...(models.length ? {} : { message: "Muse returned no models" }) };
  } catch { return { ...base, installed: true, version, status: "error", message: "Muse SDK could not read the model catalog" }; }
  finally { await native?.close().catch(() => {}); }
}
export const museEngine: EngineModule = { start, probe };
