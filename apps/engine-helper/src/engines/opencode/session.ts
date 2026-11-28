import { randomBytes, randomUUID } from "node:crypto";
import type { Event, Part, PermissionRequest, PermissionRuleset, QuestionRequest, Todo } from "@opencode-ai/sdk/v2";
import type { EngineHost, EngineSession } from "../../engine.ts";
import { assistantMessage, item, reasoning, errorItem } from "../../items.ts";
import { HelperError, type EngineInput, type InitializeParams, type RequestAnswer, type TurnSettings, type TurnOutcome } from "../../protocol.ts";
import { goatRemoteMcpConfig } from "./goatMcpConfig.ts";
import { childPermissionRules, ownsSubagentDeny, parentPermissionBases, permissionRules, permissionUpdateNeeded, questionId, resumePermissionRules } from "./permissions.ts";
import { projectTool } from "./project.ts";
import { safeHost } from "./redact.ts";
import { client, startServer, verifyServerVersion, type Sdk, type Server } from "./runtime.ts";
import { promptParts } from "./attachments.ts";

type Client = ReturnType<typeof client>;
type ChildSnapshot = { id: string; permission: PermissionRuleset; metadata: Record<string, unknown> | undefined; parentBases: PermissionRuleset[] };
type Admission = { id: string; accepted: boolean; observed: boolean; idle: boolean; pending: boolean };
type SteerReceipt = { inputIds: string[]; accepted: boolean; ready: boolean; observed: boolean };
type Turn = { id: string; settings: TurnSettings; interrupted: boolean; stopPending: boolean; stopIdle: boolean; reconciliationFailure?: string; heldOutcome?: TurnOutcome; steers: Map<string, SteerReceipt>; controller: AbortController; admission: Admission; parts: Map<string, Part>; roles: Map<string, string>; emitted: Set<string>; sentText: Map<string, string>; earlyDeltas: Map<string, { messageId: string; text: string }>; earlyDeltaBytes: number; reconciling: boolean; admitted: boolean; draining: boolean; queued: Array<{ event: Event; bytes: number }>; queuedBytes: number; todos?: Todo[]; overflow?: boolean };
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
// promptAdmission.ts:92-110: an HTTP rejection or a connection failure before sending is definite.
function promptRejected(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause !== "object" || cause === null) return false;
  if ("status" in cause && typeof cause.status === "number") return true;
  return "code" in cause && typeof cause.code === "string" && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(cause.code);
}

export class OpenCodeSession implements EngineSession {
  readonly engineRef: string;
  private active: Turn | undefined;
  private closed = false;
  private starting = false;
  private uncertain = false;
  private first: boolean;
  private readonly requests = new Map<string, Pending>();
  private readonly childSessions = new Set<string>();
  private readonly childPolicies = new Set<string>();
  private readonly detachedChildren = new Map<string, Extract<Part, { type: "tool" }>>();
  private readonly ownedMessages = new Set<string>();
  private backgroundPrompt = false;
  private subagentsDenied = false;
  private readonly abortEvents: AbortController;
  private readonly api: Client;
  private readonly server: Server;
  private readonly params: InitializeParams;
  private readonly host: EngineHost;
  private config: TurnSettings;
  private constructor(api: Client, server: Server, params: InitializeParams, host: EngineHost, ref: string, abortEvents: AbortController) {
    this.api = api; this.server = server; this.params = params; this.host = host; this.abortEvents = abortEvents;
    this.engineRef = ref; this.first = params.resume === null;
    this.config = { modelSelection: params.modelSelection, runtimeMode: params.runtimeMode };
  }
  static async create(module: Sdk, params: InitializeParams, host: EngineHost): Promise<OpenCodeSession> {
    const server = await startServer(module, params.cwd, params.launch);
    const abortEvents = new AbortController();
    try {
      const api = client(module, server, params.cwd);
      await verifyServerVersion(api);
      const events = await api.event.subscribe(undefined, { signal: abortEvents.signal });
      const resumed = params.resume ? await api.session.get({ sessionID: params.resume }, { throwOnError: true }) : undefined;
      if (params.resume && !resumed?.data?.id) throw new Error("session missing");
      const children = resumed?.data ? await OpenCodeSession.scanChildren(api, resumed.data.id, parentPermissionBases(resumed.data.permission ?? [], resumed.data.metadata)) : [];
      if (resumed?.data) await OpenCodeSession.requireIdle(api, [resumed.data.id, ...children.map((child) => child.id)]);
      if (params.mcp) {
        const added = await api.mcp.add({ name: "goat", config: goatRemoteMcpConfig(params.mcp.url, `Bearer ${params.mcp.bearerToken}`) }, { throwOnError: true });
        if (added.data?.goat?.status !== "connected") throw new HelperError("start_failed", "OpenCode GOAT MCP server is not connected");
      }
      const initialPermission = permissionRules(params.runtimeMode);
      const response = params.resume
        ? resumed!
        : await api.session.create({ permission: initialPermission, metadata: { goatPermissionBase: initialPermission, goatSubagentDeny: false } }, { throwOnError: true });
      if (!response.data?.id) throw new Error("session missing");
      if (params.resume) await OpenCodeSession.requireIdle(api, [response.data.id, ...children.map((child) => child.id)]);
      if (params.resume) {
        const { droppedUnverifiedAllows, ...desired } = resumePermissionRules(params.runtimeMode, response.data.permission ?? [], response.data.metadata);
        if (droppedUnverifiedAllows) safeHost(host, params).log("warn", `OpenCode session ${response.data.id}: unverified allow overrides were dropped`);
        if (permissionUpdateNeeded(response.data.permission ?? [], response.data.metadata, desired)) await api.session.update({ sessionID: response.data.id, ...desired }, { throwOnError: true });
      }
      const session = new OpenCodeSession(api, server, params, safeHost(host, params), response.data.id, abortEvents);
      if (params.resume) session.subagentsDenied = ownsSubagentDeny(response.data.permission ?? [], response.data.metadata);
      server.onExit(() => { if (!session.closed) session.broken("OpenCode server exited"); });
      if (params.resume) await session.restoreChildren(children);
      void session.consume(events.stream);
      return session;
    } catch (error) { abortEvents.abort(); await server.close(); if (error instanceof HelperError) throw error; throw new HelperError("start_failed", "OpenCode session initialization failed"); }
  }
  private static async scanChildren(api: Client, rootId: string, rootBases: PermissionRuleset[]): Promise<ChildSnapshot[]> {
    const seen = new Set([rootId]); const pending = [{ id: rootId, bases: rootBases }]; const found: ChildSnapshot[] = [];
    const signal = AbortSignal.timeout(10_000);
    while (pending.length) {
      const parent = pending.shift()!;
      const response = await api.session.children({ sessionID: parent.id }, { throwOnError: true, signal });
      if (!response.data) throw new Error("missing children");
      for (const child of response.data) {
        if (seen.has(child.id)) continue;
        if (seen.size >= 1024) throw new Error("too many children");
        seen.add(child.id);
        const native = child.permission ?? [];
        found.push({ id: child.id, permission: native, metadata: child.metadata, parentBases: parent.bases });
        pending.push({ id: child.id, bases: parentPermissionBases(native, child.metadata) });
      }
    }
    return found;
  }
  private static async requireIdle(api: Client, ids: string[]) {
    const status = await api.session.status({}, { throwOnError: true, signal: AbortSignal.timeout(10_000) });
    if (!status.data) throw new HelperError("start_failed", "OpenCode session ownership could not be verified");
    if (ids.some((id) => status.data?.[id] && status.data[id]?.type !== "idle")) throw new HelperError("start_failed", "OpenCode session has unowned active work");
  }
  private async restoreChildren(children: ChildSnapshot[]) {
    const signal = AbortSignal.timeout(10_000);
    for (const child of children) {
      this.childSessions.add(child.id); this.childPolicies.add(child.id);
      const desired = { permission: childPermissionRules(this.config.runtimeMode, child.permission, child.parentBases, this.subagentsDenied, child.metadata), metadata: { ...child.metadata, goatPermissionBase: permissionRules(this.config.runtimeMode), goatSubagentDeny: this.subagentsDenied } };
      if (permissionUpdateNeeded(child.permission, child.metadata, desired)) await this.api.session.update({ sessionID: child.id, ...desired }, { throwOnError: true, signal });
    }
  }
  private broken(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.active?.admitted) { this.active.controller.abort(); this.prepareTerminalSteers(this.active); this.active.stopPending = false; this.finish(this.active, { type: "failed", reason }); }
    else this.active = undefined;
    this.abortEvents.abort();
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
    if (outcome.type === "failed") {
      let invalidated = false;
      for (const [id, receipt] of turn.steers) if (!receipt.accepted) { turn.steers.delete(id); invalidated = true; }
      if (invalidated) { this.uncertain = true; turn.controller.abort(); }
    }
    if (turn.stopPending || [...turn.steers.values()].some((receipt) => !receipt.ready)) {
      if (turn.heldOutcome?.type !== "failed" || outcome.type === "failed") turn.heldOutcome = outcome;
      return;
    }
    if (outcome.type !== "failed" && (turn.earlyDeltas.size > 0 || this.hasUnknownRoles(turn))) {
      if (!turn.reconciling) {
        turn.reconciling = true;
        void this.reconcileRoles(turn, outcome);
      }
      return;
    }
    for (const part of turn.parts.values()) this.finishPart(turn, part);
    if (turn.todos) {
      const id = `${turn.id}:todo`;
      const steps = turn.todos.flatMap((t, i) => t.status === "cancelled" ? [] : [{ id: `${id}:${i + 1}`, text: t.content.trim() || `Todo ${i + 1}`, status: t.status === "completed" ? "completed" as const : t.status === "in_progress" ? "running" as const : "pending" as const }]);
      this.completed(turn, id, item(this.base(id, turn), "todo_list", { planId: id, steps }));
    }
    for (const key of this.requests.keys()) { this.requests.delete(key); this.host.emit({ type: "request_closed", key }); }
    for (const [id, receipt] of turn.steers) this.settleSteer(turn, id, receipt.observed);
    this.active = undefined;
    this.host.emit({ type: "turn_finished", turnId: turn.id, outcome });
  }
  private settleSteer(turn: Turn, id: string, observed: boolean) {
    const receipt = turn.steers.get(id); if (!receipt?.accepted || !receipt.ready) return;
    turn.steers.delete(id);
    this.host.emit({ type: "steer_updated", turnId: turn.id, inputIds: receipt.inputIds, status: observed ? { type: "completed" } : { type: "cancelled", reason: "OpenCode turn ended before steering was read" } });
  }
  private prepareTerminalSteers(turn: Turn) {
    for (const [id, receipt] of turn.steers) { if (!receipt.accepted) turn.steers.delete(id); else receipt.ready = true; }
  }
  private releaseSteer(turn: Turn, id: string) {
    if (this.active !== turn) return;
    const receipt = turn.steers.get(id);
    if (receipt) { receipt.ready = true; if (receipt.observed) this.settleSteer(turn, id, true); }
    const outcome = turn.heldOutcome;
    if (outcome && turn.interrupted) {
      if (!turn.stopPending && turn.stopIdle) { const final = this.stopOutcome(turn); delete turn.heldOutcome; this.finish(turn, final); }
      return;
    }
    if (outcome && !turn.stopPending && ![...turn.steers.values()].some((entry) => !entry.ready)) { delete turn.heldOutcome; this.finish(turn, outcome); }
  }
  private stopOutcome(turn: Turn): TurnOutcome {
    if (turn.reconciliationFailure) return { type: "failed", reason: turn.reconciliationFailure };
    return turn.heldOutcome?.type === "failed" ? turn.heldOutcome : { type: "interrupted" };
  }
  private hasUnknownRoles(turn: Turn) {
    return [...turn.parts.values()].some((part) => (part.type === "text" || part.type === "reasoning") && !turn.roles.has(part.messageID));
  }
  private async reconcileRoles(turn: Turn, outcome: TurnOutcome) {
    try {
      const history = await this.api.session.messages({ sessionID: this.engineRef }, { throwOnError: true, signal: AbortSignal.timeout(10_000) });
      if (this.active !== turn) return;
      for (const entry of history.data ?? []) {
        if ([...turn.parts.values()].some((part) => part.messageID === entry.info.id) || [...turn.earlyDeltas.values()].some((delta) => delta.messageId === entry.info.id)) turn.roles.set(entry.info.id, entry.info.role);
        for (const part of entry.parts) {
          const early = turn.earlyDeltas.get(part.id);
          if (!early) continue;
          if (part.messageID !== early.messageId || part.sessionID !== this.engineRef || (part.type !== "text" && part.type !== "reasoning")) throw new Error("inconsistent history");
          turn.parts.set(part.id, part); turn.earlyDeltaBytes -= Buffer.byteLength(early.text); turn.earlyDeltas.delete(part.id);
        }
      }
      for (const part of turn.parts.values()) if (part.type === "text") this.emitText(turn, part);
      if (turn.earlyDeltas.size || this.hasUnknownRoles(turn)) throw new Error("unresolved message");
      turn.reconciling = false;
      if (turn.interrupted) {
        if (!turn.stopPending && turn.stopIdle) this.finish(turn, this.stopOutcome(turn));
        return;
      }
      this.finish(turn, outcome);
    } catch {
      if (this.active !== turn) return;
      turn.reconciling = false;
      if (turn.interrupted && (turn.stopPending || !turn.stopIdle)) {
        turn.reconciliationFailure = "OpenCode message role could not be determined";
        return;
      }
      this.finish(turn, { type: "failed", reason: "OpenCode message role could not be determined" });
    }
  }
  private finishPart(turn: Turn, part: Part) {
    if (turn.earlyDeltas.has(part.id)) return;
    if ((part.type === "text" || part.type === "reasoning") && turn.roles.get(part.messageID) !== "assistant") return;
    const base = this.base(part.id, turn);
    if (part.type === "text" && !part.ignored && !part.synthetic) this.completed(turn, part.id, assistantMessage(base, part.text, part.messageID));
    else if (part.type === "reasoning") this.completed(turn, part.id, reasoning(base, part.text));
    else if (part.type === "tool" && part.tool.toLowerCase() !== "question" && ![...this.detachedChildren.values()].some((child) => child.id === part.id) && (part.state.status === "completed" || part.state.status === "error")) this.completed(turn, part.id, projectTool(part, turn.id, this.host, turn.settings.modelSelection.instanceId));
  }
  private emitText(turn: Turn, part: Extract<Part, { type: "text" }>) {
    if (turn.earlyDeltas.has(part.id) || turn.roles.get(part.messageID) !== "assistant" || part.ignored || part.synthetic) return;
    const before = turn.sentText.get(part.id) ?? "";
    if (part.text.startsWith(before) && part.text.length > before.length) {
      this.host.emit({ type: "text_delta", turnId: turn.id, itemId: part.id, text: part.text.slice(before.length) });
      turn.sentText.set(part.id, part.text);
    }
  }
  private async admission(turn: Turn, signal: "accepted" | "observed" | "idle" | "completed") {
    const a = turn.admission; if (!a.pending || this.active !== turn) return;
    if (signal === "idle") {
      a.idle = true;
      // A steer already accepted by OpenCode can be cancelled if a fresh native status confirms idle.
      if (!a.accepted || !turn.steers.get(a.id)?.accepted) return;
    }
    if (signal === "accepted" || signal === "completed") a.accepted = true;
    if (signal === "observed" || signal === "completed") a.observed = true;
    if (!a.accepted || (!a.observed && !(signal === "idle" && turn.steers.get(a.id)?.accepted))) return;
    if (!a.idle) { a.pending = false; return; }
    try {
      const result = await this.api.session.status({}, { throwOnError: true, signal: AbortSignal.timeout(10_000) });
      if (this.active !== turn || turn.admission !== a) return;
      if (!result.data) throw new Error("missing status");
      const status = result.data?.[this.engineRef];
      if (!status || status.type === "idle") { a.pending = false; this.finish(turn, turn.interrupted ? { type: "interrupted" } : turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" }); }
      else a.pending = false;
    } catch { if (this.active === turn && turn.admission === a) this.broken("OpenCode admission status could not be reconciled"); }
  }
  private async route(event: Event, replay = false) {
    if ((event.type === "session.created" || event.type === "session.updated") && event.properties.info.parentID && (event.properties.info.parentID === this.engineRef || this.childSessions.has(event.properties.info.parentID))) {
      const info = event.properties.info;
      this.childSessions.add(info.id);
      if (!this.childPolicies.has(info.id)) {
        this.childPolicies.add(info.id);
        try { await this.api.session.update({ sessionID: info.id, permission: childPermissionRules(this.config.runtimeMode, info.permission ?? [], [], this.subagentsDenied, info.metadata), metadata: { ...info.metadata, goatPermissionBase: permissionRules(this.config.runtimeMode), goatSubagentDeny: this.subagentsDenied } }, { throwOnError: true }); }
        catch { this.broken("OpenCode could not apply the child session policy"); return; }
      }
    }
    const turn = this.active;
    if (!turn) {
      if (event.type === "message.updated" && event.properties.sessionID === this.engineRef && event.properties.info.role === "user" && !this.ownedMessages.has(event.properties.info.id)) this.backgroundPrompt = true;
      if ((event.type === "permission.asked" || event.type === "question.asked") && (event.properties.sessionID === this.engineRef || this.childSessions.has(event.properties.sessionID))) this.broken("OpenCode background work requires unsupported host coordination");
      else if ((event.type === "session.idle" || event.type === "session.status" || event.type === "session.error") && event.properties.sessionID && this.detachedChildren.has(event.properties.sessionID)) this.broken("OpenCode background work requires unsupported host coordination");
      else if (event.type === "session.status" && event.properties.sessionID === this.engineRef && this.backgroundPrompt && event.properties.status.type !== "idle") this.broken("OpenCode background work requires unsupported host coordination");
      else if ((event.type === "session.idle" || (event.type === "session.status" && event.properties.status.type === "idle")) && event.properties.sessionID === this.engineRef) this.backgroundPrompt = false;
      return;
    }
    if (!replay && (!turn.admitted || turn.draining)) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (turn.queued.length >= 2048 || turn.queuedBytes + bytes > 4 * 1024 * 1024) { this.broken("OpenCode event inbox exceeded capacity"); return; }
      turn.queuedBytes += bytes; turn.queued.push({ event, bytes }); return;
    }
    const props = event.properties;
    if (event.type === "session.created" && event.properties.info.parentID && (event.properties.info.parentID === this.engineRef || this.childSessions.has(event.properties.info.parentID))) {
      this.childSessions.add(event.properties.info.id); return;
    }
    if ("sessionID" in props && typeof props.sessionID === "string" && props.sessionID !== this.engineRef) {
      if (!this.childSessions.has(props.sessionID)) return;
      const detached = this.detachedChildren.get(props.sessionID);
      if (detached && (event.type === "session.idle" || (event.type === "session.status" && event.properties.status.type === "idle") || event.type === "session.error")) {
        this.detachedChildren.delete(props.sessionID);
        this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: props.sessionID, status: event.type === "session.error" ? "failed" : "completed", title: "title" in detached.state ? detached.state.title : null, progress: null });
        const projected = projectTool(detached, turn.id, this.host, turn.settings.modelSelection.instanceId);
        this.completed(turn, detached.id, event.type === "session.error" ? { ...projected, status: "failed" } : projected);
        return;
      }
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
        if (msg.role === "user") { const receipt = turn.steers.get(msg.id); if (receipt) { receipt.observed = true; if (receipt.ready) this.settleSteer(turn, msg.id, true); } }
        if (msg.role === "assistant") for (const part of turn.parts.values()) if (part.messageID === msg.id && part.type === "text") this.emitText(turn, part);
        if (msg.role === "user" && msg.id === turn.admission.id) await this.admission(turn, "observed");
        if (msg.role === "assistant" && msg.time.completed !== undefined) {
          await this.admission(turn, "completed");
          for (const part of turn.parts.values()) if (part.messageID === msg.id) this.finishPart(turn, part);
        }
        return;
      }
      case "message.part.updated": {
        let part = event.properties.part;
        const early = turn.earlyDeltas.get(part.id);
        if (early) {
          if (early.messageId !== part.messageID || (part.type !== "text" && part.type !== "reasoning")) { this.broken("OpenCode event stream contained an inconsistent message part"); return; }
        }
        turn.parts.set(part.id, part);
        if (part.type === "text") this.emitText(turn, part);
        if (part.type === "tool" && part.tool.toLowerCase() === "task") {
          const meta = "metadata" in part.state ? part.state.metadata : undefined;
          const child = meta && typeof meta.sessionId === "string" ? meta.sessionId : part.id;
          if (child !== part.id) this.childSessions.add(child);
          const detached = child !== part.id && part.state.status === "completed" && meta?.background === true;
          if (detached) this.detachedChildren.set(child, part);
          const status = detached ? "running" : part.state.status === "completed" ? "completed" : part.state.status === "error" ? "failed" : "running";
          this.host.emit({ type: "subagent_update", turnId: turn.id, subagentId: child, status, title: "title" in part.state ? part.state.title : null, progress: null });
        }
        if (part.type === "tool" && part.tool.toLowerCase() !== "question") this.finishPart(turn, part);
        return;
      }
      case "message.part.delta": {
        const p = event.properties; const part = turn.parts.get(p.partID);
        if (p.field === "text" && !part) {
          const early = turn.earlyDeltas.get(p.partID);
          const bytes = Buffer.byteLength(p.delta);
          if ((early && early.messageId !== p.messageID) || (!early && turn.earlyDeltas.size >= 2048) || turn.earlyDeltaBytes + bytes > 4 * 1024 * 1024) { this.broken("OpenCode early message deltas exceeded the session limit"); return; }
          turn.earlyDeltaBytes += bytes;
          turn.earlyDeltas.set(p.partID, { messageId: p.messageID, text: (early?.text ?? "") + p.delta });
          return;
        }
        if (p.field === "text" && part && (part.type === "text" || part.type === "reasoning")) {
          const updated = { ...part, text: part.text + p.delta };
          turn.parts.set(part.id, updated);
          if (updated.type === "text") this.emitText(turn, updated);
        }
        return;
      }
      case "session.status":
        if (event.properties.status.type === "idle") { if (turn.interrupted) { turn.stopIdle = true; if (!turn.stopPending) this.finish(turn, this.stopOutcome(turn)); } else if (turn.admission.pending) await this.admission(turn, "idle"); else this.finish(turn, turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" }); }
        else await this.admission(turn, "observed");
        return;
      case "session.idle":
        if (turn.interrupted) { turn.stopIdle = true; if (!turn.stopPending) this.finish(turn, this.stopOutcome(turn)); } else if (turn.admission.pending) await this.admission(turn, "idle"); else this.finish(turn, turn.overflow ? { type: "failed", reason: "OpenCode context limit reached" } : { type: "done" });
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
    const parts = promptParts(inputs, preamble ? this.params.instructions?.firstMessagePreamble : null);
    if (!parts.length) throw new HelperError("bad_request", "OpenCode prompt requires text or an attachment");
    const options = turn.settings.modelSelection.options ?? [];
    const agent = options.find((o) => o.id === "agent")?.value;
    const variant = options.find((o) => o.id === "variant")?.value;
    const result = await this.api.session.promptAsync({ sessionID: this.engineRef, messageID: turn.admission.id, model, parts,
      ...(this.params.instructions?.appendSystemPrompt ? { system: this.params.instructions.appendSystemPrompt } : {}),
      ...(typeof agent === "string" ? { agent } : {}), ...(typeof variant === "string" && variant !== "goat:default" ? { variant } : {}) }, { throwOnError: false, signal: turn.controller.signal });
    if (result.error !== undefined) {
      if (result.response) throw new Error("OpenCode rejected the request", { cause: { status: result.response.status } });
      if (result.error instanceof Error) throw result.error;
      throw new Error("OpenCode transport outcome is unknown");
    }
    await this.admission(turn, "accepted");
  }
  async startTurn(inputs: ReadonlyArray<EngineInput>, settings: TurnSettings) {
    if (this.closed) return { status: "declined" as const, reason: "OpenCode session is closed" };
    if (this.uncertain) return { status: "declined" as const, reason: "OpenCode admission requires session recovery" };
    if (this.active || this.starting) return { status: "declined" as const, reason: "a turn is already running" };
    if (settings.runtimeMode !== this.config.runtimeMode) return { status: "declined" as const, reason: "OpenCode cannot switch runtime mode in a session" };
    this.starting = true;
    try {
    try {
      const state = await this.api.session.status({}, { throwOnError: true });
      if (this.closed) return { status: "declined" as const, reason: "OpenCode session is closed" };
      if (state.data?.[this.engineRef] && state.data[this.engineRef]?.type !== "idle") return { status: "refused_unowned" as const, reason: "OpenCode session has an unowned active turn" };
    } catch { return { status: "unknown" as const, reason: "OpenCode session status could not be checked" }; }
    if (this.active) return { status: "declined" as const, reason: "a turn is already running" };
    if (!parsedModel(settings.modelSelection.model)) return { status: "declined" as const, reason: "OpenCode model must use provider/model format" };
    if (!promptParts(inputs).length) return { status: "declined" as const, reason: "OpenCode requires text or an attachment" };
    const turn: Turn = { id: `${this.engineRef}:attempt:${randomUUID()}`, settings, interrupted: false, stopPending: false, stopIdle: false, steers: new Map(), controller: new AbortController(), admission: { id: messageId(), accepted: false, observed: false, idle: false, pending: true }, parts: new Map(), roles: new Map(), emitted: new Set(), sentText: new Map(), earlyDeltas: new Map(), earlyDeltaBytes: 0, reconciling: false, admitted: false, draining: true, queued: [], queuedBytes: 0 };
    this.active = turn;
    this.ownedMessages.add(turn.admission.id);
    try { await this.submit(turn, inputs, this.first); }
    catch (error) {
      if (this.active === turn) this.active = undefined;
      const rejected = !this.closed && promptRejected(error);
      if (!this.closed && !rejected) this.uncertain = true;
      return rejected ? { status: "declined" as const, reason: "OpenCode declined the prompt" } : { status: "unknown" as const, reason: "OpenCode prompt admission is unknown" };
    }
    if (this.closed || this.active !== turn) return { status: "unknown" as const, reason: "OpenCode session ended during admission" };
    this.config = settings;
    this.first = false;
    turn.admitted = true;
    // Promise response handlers run before setImmediate, preserving JSONL response ordering.
    setImmediate(() => { void (async () => {
      while (this.active === turn && turn.queued.length) await this.routeQueued(turn);
      if (this.active === turn) turn.draining = false;
    })().catch(() => this.broken("OpenCode event processing failed")); });
    return { status: "accepted" as const, turnId: turn.id };
    } finally { this.starting = false; }
  }
  private async routeQueued(turn: Turn) {
    const entry = turn.queued.shift(); if (!entry) return;
    turn.queuedBytes -= entry.bytes;
    await this.route(entry.event, true);
  }
  async setConfig(settings: TurnSettings) {
    if (settings.runtimeMode !== this.config.runtimeMode) throw new HelperError("unsupported", "OpenCode 1.x cannot change runtime mode in a session");
    if (settings.modelSelection.instanceId !== this.params.modelSelection.instanceId || !parsedModel(settings.modelSelection.model)) {
      throw new HelperError("bad_request", "OpenCode model selection is invalid for this session");
    }
    this.config = settings;
  }
  async steer(turnId: string, inputs: ReadonlyArray<EngineInput>) {
    const turn = this.active;
    if (!turn || turn.id !== turnId || turn.interrupted || turn.admission.pending || !promptParts(inputs).length) return { status: "declined" as const, reason: "OpenCode turn is not available for steering" };
    const previous = turn.admission;
    turn.admission = { id: messageId(), accepted: false, observed: false, idle: false, pending: true };
    const id = turn.admission.id;
    const receipt: SteerReceipt = { inputIds: inputs.map((input) => input.inputId), accepted: false, ready: false, observed: false };
    turn.steers.set(id, receipt); this.ownedMessages.add(id);
    try {
      await this.submit(turn, inputs, false);
      if (this.closed || this.active !== turn || turn.steers.get(id) !== receipt) return { status: "unknown" as const, reason: "OpenCode steering admission could not be confirmed" };
      receipt.accepted = true;
      setImmediate(() => { void (async () => {
        if (this.active === turn && turn.admission.id === id && turn.admission.idle) await this.admission(turn, "idle");
        this.releaseSteer(turn, id);
      })().catch(() => this.broken("OpenCode steering reconciliation failed")); });
      return { status: "accepted" as const };
    } catch (error) {
      turn.steers.delete(id); setImmediate(() => this.releaseSteer(turn, id));
      if (promptRejected(error)) { turn.admission = previous; return { status: "declined" as const, reason: "OpenCode declined steering" }; }
      this.uncertain = true; return { status: "unknown" as const, reason: "OpenCode steering admission could not be confirmed" };
    }
  }
  async interrupt(turnId: string) {
    const turn = this.active; if (!turn || turn.id !== turnId) return;
    turn.interrupted = true; turn.stopPending = true;
    turn.controller.abort();
    let failed = false;
    const signal = AbortSignal.timeout(10_000);
    try { await this.api.session.abort({ sessionID: this.engineRef }, { throwOnError: true, signal }); } catch { failed = true; }
    try {
      const seen = new Set([this.engineRef]); const pending = [this.engineRef];
      while (pending.length) {
        const parent = pending.shift()!;
        const children = await this.api.session.children({ sessionID: parent }, { throwOnError: true, signal });
        if (!children.data) throw new Error("missing children");
        for (const child of children.data) {
          if (seen.has(child.id)) continue;
          if (seen.size >= 2048) throw new Error("too many descendants");
          seen.add(child.id); pending.push(child.id);
          await this.api.session.abort({ sessionID: child.id }, { throwOnError: true, signal });
        }
      }
    } catch { failed = true; }
    turn.stopPending = false;
    if (failed) { this.broken("OpenCode interrupt could not be confirmed"); throw new HelperError("transport", "OpenCode interrupt failed"); }
    if (this.active === turn && turn.stopIdle) this.finish(turn, this.stopOutcome(turn));
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
  async shutdown() { this.closed = true; if (this.active) { const turn = this.active; turn.controller.abort(); if (turn.admitted) { this.prepareTerminalSteers(turn); turn.stopPending = false; this.finish(turn, turn.earlyDeltas.size || this.hasUnknownRoles(turn) ? { type: "failed", reason: "OpenCode message could not be reconciled during shutdown" } : { type: "interrupted" }); } else this.active = undefined; } this.abortEvents.abort(); await this.server.close(); }
}
