// OpenCode 2 session and event lifecycle adapted from v1 provider-opencode/server/v2/adapter.ts
// at 916b5ccc1b. A helper process owns one GOAT session and one native runtime.
import { randomUUID } from "node:crypto";
import type { FormInfo, ModelInfo, ModelRef, PermissionRequest, V2Event } from "@opencode/client";
import type { EngineHost, EngineSession } from "../../engine.ts";
import { item } from "../../items.ts";
import { HelperError, type EngineInput, type InitializeParams, type RequestAnswer, type TurnOutcome, type TurnSettings } from "../../protocol.ts";
import { goatRemoteMcpConfig } from "../opencode/goatMcpConfig.ts";
import { safeHost } from "../opencode/redact.ts";
import { buildOpenCode2Prompt } from "./attachments.ts";
import { OpenCode2Projection } from "./events.ts";
import { formQuestions, formReply } from "./forms.ts";
import { modelRef, sameModel } from "./modelRef.ts";
import { goatMcpServerName, permissionKind, permissionReply, sessionRules, type Rule } from "./permissions.ts";
import { projectToolCompletion } from "./project.ts";
import { startOpenCode2Runtime, type OpenCode2Runtime } from "./runtime.ts";

type Steer = { inputIds: string[]; accepted: boolean; ready: boolean; sent: boolean; invalidated: ReturnType<typeof Promise.withResolvers<void>>; outcome?: "completed" | "cancelled" };
type Tool = { name: string; messageId: string; input: Record<string, unknown>; childId?: string; background?: boolean; startedAt: string };
type Turn = { id: string; promptId: string; admitted: boolean; draining: boolean; queue: V2Event[]; queueBytes: number; steers: Map<string, Steer>; settled: Set<string>; running: boolean; awaitingStart: boolean; held?: TurnOutcome; interrupted: boolean; stopping: boolean; admissionCancelled: ReturnType<typeof Promise.withResolvers<void>>; finished: ReturnType<typeof Promise.withResolvers<void>>; settlement?: AbortController; projection: OpenCode2Projection; tools: Map<string, Tool>; completedTools: Set<string> };
type Pending = ({ type: "permission"; value: PermissionRequest } | { type: "form"; value: FormInfo }) & { answering?: boolean };
export type OpenCode2Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
const delay: OpenCode2Delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});
async function bounded<T>(milliseconds: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
  const timer = setTimeout(cancel, milliseconds); timer.unref();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("OpenCode 2 operation cancelled or timed out"));
    controller.signal.addEventListener("abort", fail, { once: true }); if (controller.signal.aborted) fail();
  });
  try { if (controller.signal.aborted) return await aborted; return await Promise.race([run(controller.signal), aborted]); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); controller.abort(); }
}
const clearRejections = new Set(["InvalidRequestError", "ConflictError", "UnauthorizedError", "CommandNotFoundError", "SkillNotFoundError"]);
function rejected(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { _tag?: unknown; name?: unknown };
  return (typeof value._tag === "string" && clearRejections.has(value._tag)) || (typeof value.name === "string" && clearRejections.has(value.name));
}
function olderThan226(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major! < 2 || (major === 2 && (minor! < 2 || (minor === 2 && (patch! < 6 || (patch === 6 && !!match[4])))));
}
function eventSession(event: V2Event): string | undefined {
  if (event.type === "form.created") return event.data?.form?.sessionID;
  const data: unknown = event.data;
  return typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string" ? data.sessionID : undefined;
}

export class OpenCode2Session implements EngineSession {
  readonly engineRef: string;
  private readonly runtime: OpenCode2Runtime;
  private readonly host: EngineHost;
  private readonly params: InitializeParams;
  private readonly timer: OpenCode2Delay;
  private readonly shutdownSignal = new AbortController();
  private readonly requests = new Map<string, Pending>();
  private readonly children = new Set<string>();
  private readonly runningChildren = new Set<string>();
  private readonly stranded = new Set<string>();
  private readonly catalog = new Map<string, ModelInfo>();
  private active: Turn | undefined;
  private settings: TurnSettings;
  private nativeModel: ModelRef | undefined;
  private readonly grants = new Map<string, Rule[]>();
  private closed = false;
  private starting = false;
  private uncertain = false;
  private first: boolean;
  private mcpAdded = false;
  private mcpOwned = false;
  private mcpFresh = false;
  private recovering = false;
  private fatalReason: string | undefined;
  private awaitingCancelledForm = false;
  private cancelledFormTimer: AbortController | undefined;
  private closing: Promise<void> | undefined;
  private constructor(runtime: OpenCode2Runtime, params: InitializeParams, host: EngineHost, id: string, model: ModelRef | undefined, catalog: ModelInfo[], wait: OpenCode2Delay) {
    this.runtime = runtime; this.params = params; this.host = safeHost(host, params, runtime.redactionSecrets ?? []); this.engineRef = id; this.nativeModel = model; this.timer = wait;
    this.settings = { modelSelection: params.modelSelection, runtimeMode: params.runtimeMode }; this.first = params.resume === null;
    for (const entry of catalog) this.catalog.set(`${entry.providerID}/${entry.id}`, entry);
  }
  static async create(params: InitializeParams, host: EngineHost, wait: OpenCode2Delay = delay): Promise<OpenCode2Session> {
    const runtime = await startOpenCode2Runtime({ cwd: params.cwd, launch: params.launch });
    return this.fromRuntime(runtime, params, host, wait);
  }
  static async fromRuntime(runtime: OpenCode2Runtime, params: InitializeParams, host: EngineHost, wait: OpenCode2Delay = delay): Promise<OpenCode2Session> {
    try {
      const client = runtime.client;
      let catalog: ModelInfo[] = [];
      try { catalog = (await bounded(10_000, undefined, (signal) => client.model.list({ location: { directory: params.cwd } }, { signal }))).data; } catch { /* v1 keeps the selected variant when the catalog is unavailable. */ }
      const selected = modelRef(params.modelSelection, OpenCode2Session.variants(catalog, params.modelSelection.model));
      if (!selected) throw new HelperError("bad_request", "OpenCode model must use provider/model format");
      const names = params.mcp ? { goat: goatMcpServerName(params.threadId), cua: null } : null;
      const permissions = sessionRules({ runtimeMode: params.runtimeMode }, [], [], names, false);
      const native = await bounded(15_000, undefined, (signal) => params.resume ? client.session.get({ sessionID: params.resume }, { signal }) : client.session.create({ location: { directory: params.cwd }, model: selected, permissions }, { signal }));
      if (!native?.id) throw new Error("session missing");
      let cancelledRequest: "form" | "permission" | undefined;
      if (params.resume) {
        const active = await bounded(5_000, undefined, (signal) => client.session.active({ signal }));
        if (native.id in active) throw new HelperError("start_failed", "OpenCode session has unowned active work");
        const pending = await bounded(5_000, undefined, (signal) => client.permission.request.list({ location: { directory: params.cwd } }, { signal }));
        for (const request of pending.data.filter((entry) => entry.sessionID === native.id)) { await bounded(5_000, undefined, (signal) => client.permission.reply({ sessionID: native.id, requestID: request.id, decision: "reject" }, { signal })); cancelledRequest = "permission"; }
        for (const form of await bounded(5_000, undefined, (signal) => client.session.form.list({ sessionID: native.id }, { signal }))) { await bounded(5_000, undefined, (signal) => client.session.form.cancel({ sessionID: native.id, formID: form.id }, { signal })); cancelledRequest = "form"; }
        await bounded(5_000, undefined, (signal) => client.session.update({ sessionID: native.id, permissions }, { signal }));
        if (native.location?.directory && native.location.directory !== params.cwd) await bounded(5_000, undefined, (signal) => client.session.move({ sessionID: native.id, directory: params.cwd }, { signal }));
      }
      const result = new OpenCode2Session(runtime, params, host, native.id, native.model ?? selected, catalog, wait);
      if (cancelledRequest) result.waitForCancelledForm(cancelledRequest);
      void runtime.failure.then((error) => { if (error && !result.closed) result.broken("OpenCode 2 server exited"); });
      void result.consume();
      return result;
    } catch (error) {
      try { await bounded(10_000, undefined, () => runtime.close()); }
      catch { throw new HelperError("start_failed", "OpenCode 2 initialization cleanup failed"); }
      if (error instanceof HelperError) throw error;
      throw new HelperError("start_failed", "OpenCode 2 session initialization failed");
    }
  }
  private static variants(catalog: ModelInfo[], slug: string): Set<string> | undefined {
    const entry = catalog.find((model) => `${model.providerID}/${model.id}` === slug.trim());
    return entry ? new Set(entry.variants.map((variant) => variant.id)) : undefined;
  }
  private selection(settings: TurnSettings): ModelRef | undefined { return modelRef(settings.modelSelection, OpenCode2Session.variants([...this.catalog.values()], settings.modelSelection.model)); }
  private async consume() {
    let stream = this.runtime.events;
    let recoveryBuffer: V2Event[] | undefined;
    while (!this.closed) {
      let pumpEnded = false, bufferedBytes = 0;
      const pump = (async () => {
        try {
          for await (const event of stream) {
            if (this.closed) return;
            if (recoveryBuffer) {
              const bytes = Buffer.byteLength(JSON.stringify(event));
              if (recoveryBuffer.length >= 4096 || bufferedBytes + bytes > 4 * 1024 * 1024) throw new Error("recovery buffer exceeded");
              bufferedBytes += bytes; recoveryBuffer.push(event);
            } else await this.route(event);
          }
        } finally { pumpEnded = true; }
      })();
      void pump.catch(() => {});
      if (recoveryBuffer) {
        try {
          await Promise.race([
            bounded(15_000, this.shutdownSignal.signal, (signal) => this.reconcile(signal, true)),
            pump.then(() => { throw new Error("reconnected stream ended during recovery"); }),
          ]);
          for (let passes = 0; !this.closed; passes++) {
            if (passes >= 128) throw new Error("recovery activity did not settle");
            while (recoveryBuffer.length && !this.closed) await this.route(recoveryBuffer.shift()!);
            if (!this.active?.held || !this.runningChildren.size) break;
            const active = await bounded(5_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.active({ signal }));
            if (recoveryBuffer.length) continue;
            for (const id of this.runningChildren) if (!(id in active)) this.runningChildren.delete(id);
            break;
          }
          if (pumpEnded) throw new Error("reconnected stream ended during recovery");
          recoveryBuffer = undefined; this.recovering = false;
          const turn = this.active;
          if (turn?.held) { if (turn.steers.size || turn.awaitingStart) this.scheduleSettlement(turn); else this.settleIfReady(turn); }
        } catch { if (!this.closed) this.broken("OpenCode 2 could not reconcile the event stream"); return; }
      }
      try { await pump; } catch { /* A lost stream is recovered below before the session is failed. */ }
      if (this.closed) return;
      this.recovering = true;
      let replacement: AsyncIterable<V2Event> | undefined;
      for (let attempt = 0; attempt < 5 && !this.closed; attempt++) {
        try { replacement = await this.runtime.reconnect({ signal: this.shutdownSignal.signal, timeoutMs: 10_000 }); break; }
        catch { if (attempt < 4 && !this.closed) { try { await this.timer(2_000, this.shutdownSignal.signal); } catch { return; } } }
      }
      if (this.closed) return;
      if (!replacement) { this.broken("OpenCode 2 event stream could not reconnect"); return; }
      this.mcpAdded = false; recoveryBuffer = []; stream = replacement;
    }
  }
  // adapter.ts:2290-2550: subscribe first, then backfill from the owned prompt and reconcile requests.
  private async reconcile(signal: AbortSignal, deferTerminal = false) {
    const client = this.runtime.client; const turn = this.active;
    const active = await client.session.active({ signal });
    if (!turn) { if (this.engineRef in active) throw new Error("unowned work"); return; }
    const history: Awaited<ReturnType<typeof client.message.list>>["data"] = [];
    let cursor: string | undefined; let found = false;
    for (let pages = 0; pages < 100 && !found; pages++) {
      const page = await client.message.list({ sessionID: this.engineRef, limit: 50, ...(cursor ? { cursor } : { order: "desc" as const }) }, { signal });
      for (const message of page.data) { history.push(message); if (message.id === turn.promptId) { found = true; break; } }
      if (found || !page.data.length || !page.cursor.next) break;
      cursor = page.cursor.next;
    }
    if (!found || this.active !== turn) { if (this.active !== turn) return; throw new Error("owned prompt missing"); }
    for (const message of history) if (message.type === "user") {
      const steer = turn.steers.get(message.id); if (steer && !steer.outcome) { steer.outcome = "completed"; this.emitSteer(turn, message.id); }
    }
    const idle = history.find((message) => message.type === "idle");
    let compactionOrdinal = 0;
    for (const message of history.toReversed()) {
      if (message.type === "compaction") { turn.projection.recoverCompaction(message.id, compactionOrdinal++, message.status, "summary" in message ? message.summary : undefined); continue; }
      if (message.type !== "assistant" || this.active !== turn) continue;
      const ordinals = { text: 0, reasoning: 0 };
      for (const [index, part] of message.content.entries()) {
        if (part.type === "text" || part.type === "reasoning") {
          const open = message.time.streamed === undefined && index === message.content.length - 1;
          turn.projection.recoverText(message.id, part.type, ordinals[part.type]++, part.text, !open); continue;
        }
        if (part.type !== "tool" || turn.completedTools.has(part.id)) continue;
        const existing = turn.tools.get(part.id);
        const tool = existing ?? { name: part.name, messageId: message.id, input: {}, startedAt: this.host.now() };
        if ("input" in part.state && typeof part.state.input === "object" && part.state.input !== null) tool.input = part.state.input;
        if (part.name === "subagent" && "metadata" in part.state && part.state.metadata && typeof part.state.metadata.sessionID === "string") { tool.childId = part.state.metadata.sessionID; this.children.add(tool.childId); }
        if (part.state.status !== "completed" && part.state.status !== "error") {
          turn.tools.set(part.id, tool);
          if (!existing && part.name === "subagent") this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: part.id, status: "running", title: typeof tool.input.description === "string" ? tool.input.description : null, progress: null });
          continue;
        }
        const common = { id: `recovery:${part.id}`, created: 0, durable: { aggregateID: this.engineRef, seq: 0, version: 2 }, data: { sessionID: this.engineRef, assistantMessageID: message.id, id: part.id, executed: part.executed ?? true, metadata: part.state.metadata } };
        const recovered = (part.state.status === "completed" ? { ...common, type: "session.tool.success", data: { ...common.data, content: part.state.content.map((entry) => entry.type === "file" && entry.name === null ? { ...entry, name: undefined } : entry) } } : { ...common, type: "session.tool.failed", data: { ...common.data, error: part.state.error } }) as unknown as Extract<V2Event, { type: "session.tool.success" | "session.tool.failed" }>;
        turn.tools.set(part.id, tool); await this.route(recovered, true);
      }
    }
    await this.discoverActiveChildren(active, signal);
    this.runningChildren.clear(); for (const id of this.children) if (id in active) this.runningChildren.add(id);
    const owned = [this.engineRef, ...this.children].filter((id) => id in active);
    const [requests, formLists, inbox] = await Promise.all([
      client.permission.request.list({ location: { directory: this.params.cwd } }, { signal }),
      Promise.all(owned.map((sessionID) => client.session.form.list({ sessionID }, { signal }))),
      client.session.inbox.list({ sessionID: this.engineRef }, { signal }),
    ]);
    if (this.active !== turn) return;
    const forms = formLists.flat(); const ownedSet = new Set(owned);
    const known = new Set([...requests.data.filter((request) => ownedSet.has(request.sessionID)).map((request) => request.id), ...forms.filter((form) => ownedSet.has(form.sessionID)).map((form) => form.id)]);
    for (const [key, request] of this.requests) if (!known.has(key)) { this.requests.delete(key); this.host.emit({ type: "request_closed", key }); }
    for (const request of requests.data) if (this.active === turn && ownedSet.has(request.sessionID) && !this.requests.has(request.id)) await this.openPermission(turn, request);
    for (const form of forms) if (this.active === turn && ownedSet.has(form.sessionID) && !this.requests.has(form.id)) await this.openForm(turn, form);
    const queued = new Set(inbox.map((entry) => entry.id));
    for (const [id, steer] of turn.steers) if (!steer.outcome && !queued.has(id)) throw new Error("steer state unavailable");
    if (this.engineRef in active) { delete turn.held; turn.running = true; return; }
    if (!deferTerminal && ([...this.children].some((id) => id in active) || [...turn.tools.values()].some((tool) => tool.background))) { this.broken("OpenCode 2 background subagent work cannot continue outside a GOAT turn"); return; }
    const outcome: TurnOutcome = idle?.outcome === "succeeded" ? (turn.interrupted ? { type: "interrupted" } : { type: "done" }) : idle?.outcome === "failed" ? { type: "failed", reason: "OpenCode 2 turn failed while reconnecting" } : { type: "interrupted" };
    if (deferTerminal || turn.steers.size || turn.awaitingStart) turn.held = outcome; else this.finish(turn, outcome);
  }
  private async discoverActiveChildren(active: Record<string, unknown>, signal: AbortSignal) {
    const ids = Object.keys(active); if (ids.length > 2048) throw new Error("too many active sessions");
    const parentCache = new Map<string, string | undefined>();
    for (const id of ids) {
      if (id === this.engineRef || this.children.has(id)) continue;
      const chain: string[] = []; let current: string | undefined = id;
      while (current && current !== this.engineRef && !this.children.has(current)) {
        if (chain.includes(current) || chain.length >= 64) throw new Error("invalid session ancestry");
        chain.push(current);
        if (!parentCache.has(current)) {
          const native = await this.runtime.client.session.get({ sessionID: current }, { signal });
          if (!native || native.id !== current) throw new Error("session ancestry unavailable");
          parentCache.set(current, native.parentID);
        }
        current = parentCache.get(current);
      }
      if (current === this.engineRef || (current && this.children.has(current))) for (const child of chain) this.children.add(child);
    }
  }
  private broken(reason: string) {
    if (this.closed) return; this.closed = true; this.shutdownSignal.abort();
    const turn = this.active;
    this.fatalReason = reason;
    if (turn?.admitted) { turn.stopping = false; this.finish(turn, { type: "failed", reason }); }
    else { turn?.admissionCancelled.resolve(); this.active = undefined; this.fatalReason = undefined; this.host.fail(reason); }
    void this.closeRuntime().catch(() => this.host.log("warn", "OpenCode 2 runtime cleanup failed"));
  }
  private closeRuntime() { return this.closing ??= bounded(10_000, undefined, () => this.runtime.close()).catch(() => { throw new HelperError("transport", "OpenCode 2 runtime cleanup failed"); }); }
  private waitForCancelledForm(kind: "form" | "permission" = "form") {
    this.awaitingCancelledForm = true;
    this.cancelledFormTimer?.abort();
    const controller = new AbortController(); this.cancelledFormTimer = controller;
    const stop = () => controller.abort(); this.shutdownSignal.signal.addEventListener("abort", stop, { once: true });
    void this.timer(5_000, controller.signal).then(() => { if (this.awaitingCancelledForm && !this.closed) this.broken(`OpenCode 2 cancelled ${kind} did not settle`); })
      .catch(() => { if (!controller.signal.aborted && !this.closed) this.broken("OpenCode 2 cancelled form recovery failed"); })
      .finally(() => { this.shutdownSignal.signal.removeEventListener("abort", stop); if (this.cancelledFormTimer === controller) this.cancelledFormTimer = undefined; });
  }
  private emitSteer(turn: Turn, id: string) {
    const steer = turn.steers.get(id);
    if (!steer?.accepted || !steer.ready || !steer.outcome) return;
    turn.steers.delete(id); turn.settled.add(id);
    this.host.emit({ type: "steer_updated", turnId: turn.id, inputIds: steer.inputIds, status: steer.outcome === "completed" ? { type: "completed" } : { type: "cancelled", reason: "OpenCode turn ended before steering was read" } });
  }
  private finish(turn: Turn, outcome: TurnOutcome) {
    if (this.active !== turn) return;
    if (!turn.admitted) { turn.held = outcome; return; }
    if (this.recovering && !this.closed) { if (turn.held?.type !== "failed" || outcome.type === "failed") turn.held = outcome; return; }
    if (turn.stopping) { if (turn.held?.type !== "failed" || outcome.type === "failed") turn.held = outcome; return; }
    if (!this.closed && (this.runningChildren.size > 0 || [...turn.tools.values()].some((tool) => tool.background))) { this.broken("OpenCode 2 background subagent work cannot continue outside a GOAT turn"); return; }
    if (outcome.type !== "done") {
      for (const [id, steer] of turn.steers) if (!steer.accepted) { turn.steers.delete(id); if (steer.sent && !steer.outcome) this.stranded.add(id); steer.invalidated.resolve(); }
    }
    if ([...turn.steers.values()].some((steer) => !steer.ready)) { turn.held = outcome; return; }
    for (const [id, steer] of turn.steers) { steer.outcome ??= "cancelled"; this.emitSteer(turn, id); }
    for (const key of this.requests.keys()) { this.requests.delete(key); this.host.emit({ type: "request_closed", key }); }
    const model = this.catalog.get(this.settings.modelSelection.model); const limit = model?.limit?.input ?? model?.limit?.context;
    turn.projection.finish(limit, outcome.type); this.active = undefined;
    this.host.emit({ type: "turn_finished", turnId: turn.id, outcome });
    turn.finished.resolve(); turn.settlement?.abort();
    if (this.fatalReason) { const reason = this.fatalReason; this.fatalReason = undefined; this.host.fail(reason); }
  }
  private settleIfReady(turn: Turn) {
    if (this.active !== turn || this.recovering || !turn.held || turn.awaitingStart || turn.steers.size > 0) return;
    const outcome = turn.held; delete turn.held; turn.settlement?.abort(); delete turn.settlement; this.finish(turn, outcome);
  }
  private scheduleSettlement(turn: Turn) {
    if (turn.settlement || this.closed || this.recovering) return;
    const controller = new AbortController(); turn.settlement = controller;
    const abort = () => controller.abort(); this.shutdownSignal.signal.addEventListener("abort", abort, { once: true });
    void this.timer(5_000, controller.signal).then(async () => {
      if (this.active !== turn || !turn.held || controller.signal.aborted) return;
      try { await bounded(15_000, this.shutdownSignal.signal, (signal) => this.reconcile(signal)); } catch { /* the visible failure below preserves unresolved inputs */ }
      if (this.active === turn && turn.held && !controller.signal.aborted) this.broken("OpenCode 2 could not settle queued steering");
    }).catch(() => { if (!controller.signal.aborted && !this.closed) this.broken("OpenCode 2 steering recovery timer failed"); }).finally(() => { this.shutdownSignal.signal.removeEventListener("abort", abort); if (turn.settlement === controller) delete turn.settlement; });
  }
  private async route(event: V2Event, replay = false): Promise<void> {
    const sessionID = eventSession(event);
    if (this.active && !sessionID && (event.type === "session.execution.started" || event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted" || event.type === "session.execution.failed")) { this.broken("OpenCode 2 execution event could not be routed"); return; }
    if (event.type === "session.created" && event.data.parentID && (event.data.parentID === this.engineRef || this.children.has(event.data.parentID))) this.children.add(event.data.sessionID);
    const owned = sessionID === this.engineRef || (sessionID !== undefined && this.children.has(sessionID));
    if (!owned) return;
    if (sessionID && sessionID !== this.engineRef) {
      if (event.type === "session.execution.started") this.runningChildren.add(sessionID);
      else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") this.runningChildren.delete(sessionID);
    }
    if (sessionID === this.engineRef && this.awaitingCancelledForm && (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted" || event.type === "session.execution.failed")) { this.awaitingCancelledForm = false; this.cancelledFormTimer?.abort(); return; }
    const turn = this.active;
    if (!turn) {
      if (event.type === "session.execution.started" || event.type === "permission.asked" || event.type === "form.created" || (event.type === "session.inbox.enqueued" && event.data.item.type === "user")) this.broken("OpenCode 2 started unowned work outside a GOAT turn");
      return;
    }
    if ((!turn.admitted || turn.draining) && !replay) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (turn.queue.length >= 4096 || turn.queueBytes + bytes > 4 * 1024 * 1024) { this.broken("OpenCode 2 admission event buffer exceeded its limit"); return; }
      turn.queueBytes += bytes; turn.queue.push(event); return;
    }
    if (event.type === "permission.asked") return this.openPermission(turn, event.data);
    if (event.type === "form.created") return this.openForm(turn, event.data.form);
    if (event.type === "permission.replied" || event.type === "form.replied" || event.type === "form.cancelled") {
      const key = event.type === "permission.replied" ? event.data.requestID : event.data.id;
      if (this.requests.delete(key)) this.host.emit({ type: "request_closed", key }); return;
    }
    if (sessionID !== this.engineRef) {
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        const entry = [...turn.tools.entries()].find(([, tool]) => tool.name === "subagent" && tool.childId === sessionID);
        if (entry) {
          const [id, tool] = entry; const status = event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "failed" : "interrupted";
          this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: id, status, title: typeof tool.input.description === "string" ? tool.input.description : null, progress: null });
          if (tool.background) {
            const base = { id, nativeId: id, turnId: turn.id, driver: "opencode", now: this.host.now(), status } as const;
            this.host.emit({ type: "item_completed", turnId: turn.id, item: item(base, "subagent", { subagentId: id, origin: "provider_native", driver: "opencode", providerInstanceId: this.params.modelSelection.instanceId, childThreadId: null, prompt: typeof tool.input.prompt === "string" ? tool.input.prompt : "", result: null }), locator: { turnId: turn.id, itemId: id } });
            turn.tools.delete(id); turn.completedTools.add(id);
          }
        }
      }
      return;
    }
    if (event.type === "session.inbox.enqueued" && event.data.item.type === "user" && event.data.inboxID !== turn.promptId && !turn.steers.has(event.data.inboxID) && !turn.settled.has(event.data.inboxID)) {
      this.broken("OpenCode 2 started unowned work outside a GOAT turn"); return;
    }
    if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
      const steer = turn.steers.get(event.data.inboxID); if (!steer || steer.outcome) return;
      steer.outcome = event.type === "session.inbox.delivered" ? "completed" : "cancelled";
      if (steer.outcome === "completed" && turn.held && !turn.running) turn.awaitingStart = true;
      this.emitSteer(turn, event.data.inboxID);
      if (event.type === "session.inbox.cancelled") this.settleIfReady(turn);
      return;
    }
    if (event.type === "session.execution.started") {
      if (this.recovering && turn.held?.type === "failed") { this.broken("OpenCode 2 execution failed during stream recovery"); return; }
      turn.running = true; turn.awaitingStart = false; delete turn.held; turn.settlement?.abort(); delete turn.settlement; return;
    }
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted" || event.type === "session.execution.failed") {
      turn.running = false;
      const outcome: TurnOutcome = event.type === "session.execution.failed" ? { type: "failed", reason: "OpenCode 2 turn failed" } : event.type === "session.execution.interrupted" || turn.interrupted ? { type: "interrupted" } : { type: "done" };
      if (!this.recovering && !turn.stopping && (this.runningChildren.size > 0 || [...turn.tools.values()].some((tool) => tool.background))) { this.broken("OpenCode 2 background subagent work cannot continue outside a GOAT turn"); return; }
      if (outcome.type === "failed") { this.finish(turn, outcome); return; }
      if (turn.steers.size || turn.awaitingStart) { turn.held = outcome; this.scheduleSettlement(turn); return; }
      this.finish(turn, outcome); return;
    }
    if (event.type === "session.tool.input.started") {
      if (turn.completedTools.has(event.data.id)) return;
      if (event.data.name !== "question") {
        turn.tools.set(event.data.id, { name: event.data.name, messageId: event.data.assistantMessageID, input: {}, startedAt: this.host.now() });
        if (event.data.name === "subagent") this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: event.data.id, status: "running", title: null, progress: null });
      }
      return;
    }
    if (event.type === "session.tool.called") { if (turn.completedTools.has(event.data.id)) return; const tool = turn.tools.get(event.data.id); if (tool) tool.input = event.data.input; return; }
    if (event.type === "session.tool.progress") { if (turn.completedTools.has(event.data.id)) return; const tool = turn.tools.get(event.data.id); if (tool && typeof event.data.metadata.sessionID === "string") { tool.childId = event.data.metadata.sessionID; this.children.add(tool.childId); } return; }
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      if (turn.completedTools.has(event.data.id)) return;
      const tool = turn.tools.get(event.data.id); if (!tool) { this.broken("OpenCode 2 tool event has no matching start"); return; }
      const child = typeof event.data.metadata?.sessionID === "string" ? event.data.metadata.sessionID : tool.childId;
      if (child) this.children.add(child);
      if (tool.name === "subagent" && event.type === "session.tool.success" && event.data.metadata?.status === "running") tool.background = true;
      const projected = projectToolCompletion(event, { turnId: turn.id, sessionId: this.engineRef, assistantMessageId: tool.messageId, toolId: event.data.id, name: tool.name, input: tool.input, now: this.host.now(), startedAt: tool.startedAt, todoPlanId: `${this.engineRef}:todo`, ...(tool.name === "subagent" ? { subagent: { id: event.data.id, instanceId: this.params.modelSelection.instanceId, childThreadId: null } } : {}) });
      if (!projected) { this.broken("OpenCode 2 tool result could not be projected"); return; }
      for (const value of projected) this.host.emit(value);
      if (tool.background) return;
      if (tool.name === "subagent") this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: event.data.id, status: event.type === "session.tool.success" ? "completed" : event.data.error.type === "aborted" ? "interrupted" : "failed", title: typeof tool.input.description === "string" ? tool.input.description : null, progress: null });
      turn.completedTools.add(event.data.id); turn.tools.delete(event.data.id); return;
    }
    try { turn.projection.handle(event); }
    catch { this.broken("OpenCode 2 event content conflicted with recovered history"); }
  }
  private async openPermission(turn: Turn, request: PermissionRequest) {
    if (this.requests.has(request.id)) return;
    this.requests.set(request.id, { type: "permission", value: request });
    const kind = permissionKind(request.action, request.source ? turn.tools.get(request.source.id)?.name : undefined);
    const base = { id: request.id, nativeId: request.id, turnId: turn.id, driver: "opencode", now: this.host.now(), status: "waiting" as const, completedAt: null };
    this.host.emit({ type: "request_opened", turnId: turn.id, key: request.id, itemId: request.id, kind: "approval", summary: `OpenCode ${request.action} approval`, item: item(base, "approval_request", { requestId: request.id, requestKind: kind }) });
  }
  private async openForm(turn: Turn, form: FormInfo) {
    if (this.requests.has(form.id)) return;
    const mapped = formQuestions(form);
    if ("unsupported" in mapped) {
      try { await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal })); }
      catch { this.broken("OpenCode 2 unsupported form could not be cancelled"); return; }
      if (form.sessionID === this.engineRef) this.waitForCancelledForm();
      this.finish(turn, { type: "failed", reason: `OpenCode asked for ${mapped.unsupported}, which cannot be shown` }); return;
    }
    this.requests.set(form.id, { type: "form", value: form });
    const base = { id: form.id, nativeId: form.id, turnId: turn.id, driver: "opencode", now: this.host.now(), status: "waiting" as const, completedAt: null };
    this.host.emit({ type: "request_opened", turnId: turn.id, key: form.id, itemId: form.id, kind: "question", summary: "OpenCode question", item: item(base, "user_input_request", { requestId: form.id, questions: mapped.questions }) });
  }
  private async ensureMcp() {
    if (!this.params.mcp || this.mcpAdded) return;
    await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.mcp.add({ server: goatMcpServerName(this.params.threadId), location: { directory: this.params.cwd }, config: goatRemoteMcpConfig(this.params.mcp!.url, `Bearer ${this.params.mcp!.bearerToken}`) }, { signal }));
    this.mcpAdded = true; this.mcpOwned = true; this.mcpFresh = true;
  }
  async setConfig(settings: TurnSettings) {
    if (this.closed) throw new HelperError("transport", "OpenCode 2 session is closed");
    if (settings.modelSelection.instanceId !== this.params.modelSelection.instanceId) throw new HelperError("bad_request", "OpenCode model belongs to a different instance");
    const model = this.selection(settings); if (!model) throw new HelperError("bad_request", "OpenCode model must use provider/model format");
    const names = this.params.mcp ? { goat: goatMcpServerName(this.params.threadId), cua: null } : null;
    const grants = settings.runtimeMode === "full-access" ? [] : this.grants.get(this.engineRef) ?? [];
    const permissions = sessionRules({ runtimeMode: settings.runtimeMode }, [], grants, names, false);
    try {
      if (settings.runtimeMode !== this.settings.runtimeMode) await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.update({ sessionID: this.engineRef, permissions }, { signal }));
      if (this.closed) throw new HelperError("transport", "OpenCode 2 session is closed");
      if (!sameModel(model, this.nativeModel)) { await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.switchModel({ sessionID: this.engineRef, model }, { signal })); this.nativeModel = model; }
    } catch (error) { if (error instanceof HelperError) throw error; throw new HelperError("transport", "OpenCode 2 configuration update failed"); }
    this.settings = settings;
  }
  async startTurn(inputs: ReadonlyArray<EngineInput>, settings: TurnSettings) {
    if (this.closed || this.active || this.starting || this.uncertain || this.recovering || this.awaitingCancelledForm) return { status: "declined" as const, reason: "OpenCode 2 session is not ready for a new turn" };
    this.starting = true;
    try {
      let active: Awaited<ReturnType<typeof this.runtime.client.session.active>>;
      try { active = await bounded(5_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.active({ signal })); } catch { return { status: "declined" as const, reason: "OpenCode 2 active work could not be checked" }; }
      if (this.closed) return { status: "declined" as const, reason: "OpenCode 2 session is closed" };
      if (this.engineRef in active) return { status: "refused_unowned" as const, reason: "OpenCode 2 session has unowned active work" };
      try {
        for (const inboxID of this.stranded) { try { await bounded(5_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.inbox.cancel({ sessionID: this.engineRef, inboxID }, { signal })); } catch { throw new HelperError("start_failed", "OpenCode 2 could not cancel an uncertain earlier steer"); } this.stranded.delete(inboxID); }
        await this.setConfig(settings);
        if (this.closed) return { status: "declined" as const, reason: "OpenCode 2 session is closed" };
        try { await this.ensureMcp(); } catch { throw new HelperError("start_failed", "OpenCode 2 could not connect the GOAT MCP server"); }
        if (this.closed) return { status: "declined" as const, reason: "OpenCode 2 session is closed" };
        if (this.params.instructions?.appendSystemPrompt) await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.instructions.entry.put({ sessionID: this.engineRef, key: "goat", value: this.params.instructions!.appendSystemPrompt! }, { signal }));
        if (this.mcpFresh && olderThan226(this.runtime.version)) await this.timer(250, this.shutdownSignal.signal);
        this.mcpFresh = false;
        const prompt = await buildOpenCode2Prompt(inputs, this.first ? this.params.instructions?.firstMessagePreamble : null);
        if (!prompt.text && !prompt.files.length) return { status: "declined" as const, reason: "OpenCode 2 requires text or an attachment" };
        if (this.closed) return { status: "declined" as const, reason: "OpenCode 2 session is closed" };
        const id = `${this.engineRef}:attempt:${randomUUID()}`;
        const promptId = `msg_t3_turn_${this.engineRef}:${randomUUID()}`;
        const turn: Turn = { id, promptId, admitted: false, draining: true, queue: [], queueBytes: 0, steers: new Map(), settled: new Set(), running: false, awaitingStart: false, interrupted: false, stopping: false, admissionCancelled: Promise.withResolvers<void>(), finished: Promise.withResolvers<void>(), projection: new OpenCode2Projection(this.host, id), tools: new Map(), completedTools: new Set() };
        this.active = turn;
        const submission = new AbortController();
        const compact = inputs.every((input) => input.attachments.length === 0) && inputs.map((input) => input.text).filter(Boolean).join("\n").trim() === "/compact";
        try { const sent = await Promise.race([bounded(30_000, AbortSignal.any([this.shutdownSignal.signal, submission.signal]), (signal) => compact
          ? this.runtime.client.session.compact({ sessionID: this.engineRef, id: promptId }, { signal }).then(() => undefined)
          : this.runtime.client.session.prompt({ sessionID: this.engineRef, id: promptId, text: prompt.text, ...(prompt.files.length ? { files: prompt.files } : {}) }, { signal }).then(() => undefined)).then(() => true), turn.admissionCancelled.promise.then(() => false)]); if (!sent) return { status: "unknown" as const, reason: "OpenCode 2 session ended during admission" }; }
        catch (error) { if (this.active === turn) this.active = undefined; if (!rejected(error)) this.uncertain = true; return rejected(error) ? { status: "declined" as const, reason: "OpenCode 2 declined the prompt" } : { status: "unknown" as const, reason: "OpenCode 2 prompt admission is unknown" }; }
        finally { submission.abort(); }
        if (this.closed || this.active !== turn) return { status: "unknown" as const, reason: "OpenCode 2 session ended during admission" };
        turn.admitted = true; if (!compact) this.first = false;
        setImmediate(() => { void (async () => { while (this.active === turn && turn.queue.length) { const event = turn.queue.shift()!; turn.queueBytes -= Buffer.byteLength(JSON.stringify(event)); await this.route(event, true); } if (this.active === turn) turn.draining = false; })().catch(() => this.broken("OpenCode 2 event processing failed")); });
        return { status: "accepted" as const, turnId: id };
      } catch (error) { if (this.closed) return { status: "declined" as const, reason: "OpenCode 2 session is closed" }; if (error instanceof HelperError) return { status: "declined" as const, reason: error.message }; return { status: "declined" as const, reason: "OpenCode 2 turn could not be prepared" }; }
    } finally { this.starting = false; }
  }
  async steer(turnId: string, inputs: ReadonlyArray<EngineInput>) {
    const turn = this.active; if (!turn || turn.id !== turnId || !turn.admitted || turn.interrupted || this.closed || this.recovering) return { status: "declined" as const, reason: "OpenCode 2 turn is not available for steering" };
    const id = `msg_t3_steer_${this.engineRef}:${randomUUID()}`; const steer: Steer = { inputIds: inputs.map((input) => input.inputId), accepted: false, ready: false, sent: false, invalidated: Promise.withResolvers<void>() }; turn.steers.set(id, steer);
    try {
      const prompt = await buildOpenCode2Prompt(inputs); if (!prompt.text && !prompt.files.length) { turn.steers.delete(id); setImmediate(() => this.settleIfReady(turn)); return { status: "declined" as const, reason: "OpenCode 2 requires text or an attachment" }; }
      if (this.closed || this.active !== turn || turn.steers.get(id) !== steer) return { status: "declined" as const, reason: "OpenCode 2 session ended before steering" };
      steer.sent = true;
      const submission = new AbortController(); let sent: boolean;
      try { sent = await Promise.race([bounded(30_000, AbortSignal.any([this.shutdownSignal.signal, submission.signal]), (signal) => this.runtime.client.session.prompt({ sessionID: this.engineRef, id, text: prompt.text, ...(prompt.files.length ? { files: prompt.files } : {}), delivery: "steer" }, { signal })).then(() => true), steer.invalidated.promise.then(() => false)]); }
      finally { submission.abort(); }
      if (!sent) return { status: "unknown" as const, reason: "OpenCode 2 steering admission is unknown" };
      if (this.closed || this.active !== turn || turn.steers.get(id) !== steer) return { status: "unknown" as const, reason: "OpenCode 2 steering admission is unknown" };
      steer.accepted = true; setImmediate(() => {
        if (this.active !== turn) return;
        steer.ready = true; this.emitSteer(turn, id);
        if (turn.held && turn.held.type !== "done") { const outcome = turn.held; delete turn.held; this.finish(turn, outcome); }
        else this.settleIfReady(turn);
      });
      return { status: "accepted" as const };
    } catch (error) {
      turn.steers.delete(id); if (steer.sent && !steer.outcome && !rejected(error)) this.stranded.add(id); setImmediate(() => this.settleIfReady(turn));
      return rejected(error) ? { status: "declined" as const, reason: "OpenCode 2 declined steering" } : { status: "unknown" as const, reason: "OpenCode 2 steering admission is unknown" };
    }
  }
  async interrupt(turnId: string) {
    const turn = this.active; if (!turn || turn.id !== turnId) return;
    if (turn.stopping) throw new HelperError("bad_request", "OpenCode 2 interrupt is already pending");
    turn.stopping = true;
    let stoppingChild = false;
    try {
      const stopChildren = async () => {
        if (!this.children.size) return;
        stoppingChild = true;
        for (let pass = 0; pass < 3; pass++) {
          const active = await bounded(5_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.active({ signal }));
          const children = [...this.children].filter((id) => id in active);
          if (!children.length) { stoppingChild = false; return; }
          for (const sessionID of children) {
            const result = await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.interrupt({ sessionID }, { signal }));
            await bounded(10_000, this.shutdownSignal.signal, async (signal) => {
              for (;;) {
                const current = await this.runtime.client.session.active({ signal });
                if (!(sessionID in current)) { this.runningChildren.delete(sessionID); return; }
                if (!result.interrupted) throw new Error("child still running");
                await this.timer(250, signal);
              }
            });
          }
        }
        const remaining = await bounded(5_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.active({ signal }));
        if ([...this.children].some((id) => id in remaining)) throw new Error("new child work could not be stopped");
        stoppingChild = false;
      };
      await stopChildren();
      const result = await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.interrupt({ sessionID: this.engineRef }, { signal }));
      if (!result.interrupted) throw new HelperError("transport", "OpenCode 2 interrupt was not confirmed");
      await stopChildren();
      turn.interrupted = true;
    } catch (error) {
      if (stoppingChild && !this.closed) this.broken("OpenCode 2 could not stop native child work");
      if (error instanceof HelperError) throw error;
      throw new HelperError("transport", "OpenCode 2 interrupt failed");
    } finally {
      turn.stopping = false;
      if (this.active === turn && turn.held) {
        const outcome = turn.held.type === "failed" || !turn.interrupted ? turn.held : { type: "interrupted" as const };
        delete turn.held; this.finish(turn, outcome);
      }
    }
  }
  async answerRequest(key: string, answer: RequestAnswer) {
    const request = this.requests.get(key); if (!request) throw new HelperError("bad_request", "No open OpenCode request");
    if (request.answering) throw new HelperError("bad_request", "OpenCode request is already being answered");
    request.answering = true;
    try {
      if (request.type === "form") { const reply = formReply(request.value, answer); if (reply.type === "cancel") await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.form.cancel(reply, { signal })); else await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.form.reply(reply, { signal })); }
      else { const grants = this.grants.get(request.value.sessionID) ?? []; const result = permissionReply(request.value, answer.outcome, grants); if (result.grants.length !== grants.length) { const names = this.params.mcp ? { goat: goatMcpServerName(this.params.threadId), cua: null } : null; const applied = this.settings.runtimeMode === "full-access" ? [] : result.grants; await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.session.update({ sessionID: request.value.sessionID, permissions: sessionRules({ runtimeMode: this.settings.runtimeMode }, [], applied, names, false) }, { signal })); this.grants.set(request.value.sessionID, result.grants); } await bounded(10_000, this.shutdownSignal.signal, (signal) => this.runtime.client.permission.reply(result.reply, { signal })); }
    } catch (error) { if (error instanceof HelperError) throw error; throw new HelperError("transport", "OpenCode 2 request response failed"); }
    finally { delete request.answering; }
    if (this.requests.delete(key)) this.host.emit({ type: "request_closed", key });
  }
  async shutdown() {
    if (this.closed) { if (this.closing) await this.closing; return; } this.closed = true; this.shutdownSignal.abort();
    const turn = this.active;
    if (turn?.admitted) { turn.stopping = false; this.finish(turn, { type: "interrupted" }); if (this.active === turn) await turn.finished.promise; }
    else if (turn) { turn.admissionCancelled.resolve(); this.active = undefined; }
    try { if (turn) await bounded(5_000, undefined, (signal) => this.runtime.client.session.interrupt({ sessionID: this.engineRef }, { signal })); } catch { this.host.log("warn", "OpenCode 2 could not confirm shutdown interruption"); }
    try { if (this.mcpOwned) await bounded(5_000, undefined, (signal) => this.runtime.client.mcp.remove({ server: goatMcpServerName(this.params.threadId), location: { directory: this.params.cwd } }, { signal })); }
    catch { this.host.log("warn", "OpenCode 2 could not remove its MCP registration"); }
    finally { await this.closeRuntime(); }
  }
}
