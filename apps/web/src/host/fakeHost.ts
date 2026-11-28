// Fake host for verification and the public prototype only (?fake=<scene> or no host configured in the
// browser prototype, marked "Demo" in the UI). It speaks the same frames as goat2-host
// (crates/goat2-contracts subscribe.rs) and implements the commands per structure/30_wire.md. It never
// pretends an engine ran: a demo run answers that no engine is connected.
import type { ConnectionState, Transport } from "./transport.ts";
import type {
  BotProfile, ClientFrame, CommandResult, CommandValue, HostFrame, LogLine, ThreadCard, TurnItem,
} from "./wire.ts";

type Ev = LogLine extends infer L ? (L extends LogLine ? Omit<L, "v" | "seq" | "at"> : never) : never;

export interface FakeThread { card: ThreadCard; lines: LogLine[] }
export interface FakeWorld {
  epoch: string;
  bots: BotProfile[];
  threads: Record<string, FakeThread>;
}
export interface FakeOptions {
  /** "never": the socket stays connecting (send-first scenes). */
  connect?: "open" | "never";
  /** Delay before frames are delivered, ms. */
  latency?: number;
  /** Delay between demo run steps, ms. */
  runStepMs?: number;
  now?: () => string;
}

let cardSeqCounter = 1000;

type AuthResponse = Extract<ClientFrame, { type: "provider_auth_respond" }>["response"];
/** Credentials values and terminal data are secrets: keep the shape, never the values. */
export function redactAuthResponse(r: AuthResponse): AuthResponse {
  if (r.type === "credentials") return { type: "credentials", values: Object.fromEntries(Object.keys(r.values).map((k) => [k, "<redacted>"])) };
  if (r.type === "terminal") return { ...r, data: "<redacted>" };
  return r;
}

export function line(seq: number, at: string, ev: Ev): LogLine {
  return { v: 1, seq, at, ...ev } as LogLine;
}

export function item(threadId: string, runId: string, id: string, at: string, body: Record<string, unknown> & { type: TurnItem["type"] }): TurnItem {
  return {
    id, threadId, runId, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
    ordinal: 0, status: "completed", title: null, startedAt: at, completedAt: at, updatedAt: at, ...body,
  } as TurnItem;
}

export class FakeHost implements Transport {
  state: ConnectionState = "connecting";
  private frameCbs = new Set<(f: HostFrame) => void>();
  private stateCbs = new Set<(s: ConnectionState) => void>();
  private cardSubs = new Set<string>();
  private threadSubs = new Map<string, string>(); // subId -> threadId
  private results = new Map<string, { args: string; result: Omit<CommandResult, "reqId"> }>();
  private readonly opts: Required<FakeOptions>;
  private closed = false;
  readonly world: FakeWorld;
  /** Every client frame received (tests). */
  readonly received: ClientFrame[] = [];

  constructor(world: FakeWorld, opts: FakeOptions = {}) {
    this.world = world;
    this.opts = { connect: "open", latency: 0, runStepMs: 400, now: () => new Date().toISOString(), ...opts };
    if (this.opts.connect === "open") setTimeout(() => this.setState("open"), 0);
  }

  // ------------------------------------------------------------ Transport
  onFrame(cb: (f: HostFrame) => void) { this.frameCbs.add(cb); return () => { this.frameCbs.delete(cb); }; }
  onState(cb: (s: ConnectionState) => void) { this.stateCbs.add(cb); return () => { this.stateCbs.delete(cb); }; }
  close() { this.closed = true; this.setState("closed"); }
  /** Tests: drop the connection (frames in flight are lost). */
  drop() { this.cardSubs.clear(); this.threadSubs.clear(); this.setState("closed"); }
  reconnect() { this.setState("open"); }
  private setState(s: ConnectionState) {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }
  private emit(f: HostFrame) {
    if (this.closed || this.state !== "open") return;
    const deliver = () => { if (this.state === "open") for (const cb of this.frameCbs) cb(f); };
    if (this.opts.latency > 0) setTimeout(deliver, this.opts.latency); else queueMicrotask(deliver);
  }

  send(frame: ClientFrame) {
    if (this.state !== "open") return;
    // The test log never keeps secrets: an auth response is recorded with its values redacted.
    this.received.push(frame.type === "provider_auth_respond" ? { ...frame, response: redactAuthResponse(frame.response) } : frame);
    switch (frame.type) {
      case "subscribe_cards": {
        this.cardSubs.add(frame.subId);
        this.emit({ type: "cards_reset", subId: frame.subId, reason: "epoch_changed", epoch: this.world.epoch });
        for (const b of this.world.bots) this.emit({ type: "bot_changed", subId: frame.subId, bot: b });
        let max = 0;
        for (const t of Object.values(this.world.threads)) { max = Math.max(max, t.card.cardSeq); this.emit({ type: "card_changed", subId: frame.subId, card: t.card }); }
        this.emit({ type: "cards_caught_up", subId: frame.subId, cursor: { epoch: this.world.epoch, cardSeq: max } });
        return;
      }
      case "subscribe_thread": {
        const t = this.world.threads[frame.threadId];
        if (!t) { this.emit({ type: "thread_reset", subId: frame.subId, threadId: frame.threadId, reason: "thread_missing", epoch: this.world.epoch }); return; }
        this.threadSubs.set(frame.subId, frame.threadId);
        const after = frame.after && frame.after.epoch === this.world.epoch ? frame.after.seq : 0;
        for (const l of t.lines) if (l.seq > after) this.emit({ type: "thread_event", subId: frame.subId, threadId: frame.threadId, line: l });
        const last = t.lines.at(-1)?.seq ?? 0;
        this.emit({ type: "thread_caught_up", subId: frame.subId, threadId: frame.threadId, cursor: { epoch: this.world.epoch, seq: last } });
        return;
      }
      case "unsubscribe":
        this.cardSubs.delete(frame.subId);
        this.threadSubs.delete(frame.subId);
        return;
      case "read_page": {
        const t = this.world.threads[frame.threadId];
        const older = (t?.lines ?? []).filter((l) => l.seq < frame.before);
        const page = older.slice(-frame.limit);
        this.emit({ type: "page", reqId: frame.reqId, threadId: frame.threadId, lines: page, hasMore: older.length > page.length });
        return;
      }
      case "subscribe_providers":
        // The demo world has no provider instances; the providers UI (goat2_providers_ui) shows its empty state.
        this.emit({ type: "providers", subId: frame.subId, providers: [] });
        return;
      case "resync_item":
      case "pong":
        return;
      default:
        this.command(frame);
    }
  }

  // ------------------------------------------------------------ commands
  private command(frame: Extract<ClientFrame, { reqId: string; clientRequestId: string }>) {
    if (frame.type === "provider_auth_respond") {
      this.emit({ ...this.unavailable("not_available", "unavailable", "provider_auth_respond is not available in the demo host."), reqId: frame.reqId } as CommandResult);
      return;
    }
    const { reqId, clientRequestId, ...args } = frame;
    const key = JSON.stringify(args);
    const seen = this.results.get(clientRequestId);
    if (seen) {
      if (seen.args !== key) {
        this.emit({ type: "command_result", reqId, ok: false, error: { code: "conflict", reason: "idempotency_conflict", message: "This request id was already used for a different command.", retryable: false } });
      } else {
        this.emit({ ...seen.result, reqId, ...(seen.result.value ? { value: { ...seen.result.value, deduped: true } } : {}) } as CommandResult);
      }
      return;
    }
    const result = this.run(frame);
    this.results.set(clientRequestId, { args: key, result });
    this.emit({ ...result, reqId } as CommandResult);
  }

  private ok(value: CommandValue = {}): Omit<CommandResult, "reqId"> { return { type: "command_result", ok: true, value }; }
  private fail(reason: "thread_not_found" | "request_not_found" | "not_queued" | "invalid_request", message: string): Omit<CommandResult, "reqId"> {
    const code = reason === "not_queued" ? "failed_precondition" as const : reason === "invalid_request" ? "invalid_request" as const : "not_found" as const;
    return { type: "command_result", ok: false, error: { code, reason, message, retryable: false } };
  }

  private run(frame: Extract<ClientFrame, { reqId: string; clientRequestId: string }>): Omit<CommandResult, "reqId"> {
    const now = this.opts.now();
    switch (frame.type) {
      case "send_input": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const inputId = `in-${frame.clientRequestId}`;
        this.append(t, { type: "input.accepted", inputId, from: { kind: "user" }, mode: frame.mode, text: frame.text, clientRequestId: frame.clientRequestId, ...(frame.attachments ? { attachments: frame.attachments } : {}) });
        if (!this.activeRun(t)) this.startDemoRun(t, [inputId]);
        else this.touch(t, {});
        return this.ok({ threadId: t.card.id, inputId });
      }
      case "resolve_request": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const open = this.openRequestIds(t);
        if (!open.has(frame.requestId)) return this.fail("request_not_found", "That request is no longer open.");
        // Check the answer against the waiting item's choices, as the engine would.
        const waiting = t.lines.flatMap((l) => (l.type === "item.completed" && (l.item.type === "approval_request" || l.item.type === "user_input_request") && l.item.requestId === frame.requestId ? [l.item] : []))[0];
        if (waiting?.type === "approval_request") {
          const offered = waiting.options?.map((o) => o.decision) ?? ["accept", "decline"];
          if (!offered.includes(frame.outcome as never)) return this.fail("invalid_request", "That choice was not offered.");
        }
        if (waiting?.type === "user_input_request") {
          const missing = waiting.questions.filter((q) => q.required !== false && frame.answers?.[q.id] === undefined);
          if (frame.outcome !== "answered" || missing.length) return this.fail("invalid_request", "Answer the required questions.");
        }
        this.append(t, { type: "request.resolved", requestId: frame.requestId, outcome: frame.outcome, ...(frame.optionId ? { optionId: frame.optionId } : {}), ...(frame.text ? { text: frame.text } : {}), ...(frame.answers ? { answers: frame.answers } : {}) });
        if (frame.answers && typeof window !== "undefined") (window as unknown as { __goat2FakeAnswers?: unknown }).__goat2FakeAnswers = frame.answers; // tests read it
        const stillOpen = this.openRequestIds(t).size > 0;
        this.touch(t, { status: stillOpen ? "needs_you" : this.activeRun(t) ? "running" : "idle", needsYou: stillOpen ? t.card.needsYou : null });
        return this.ok({ threadId: t.card.id, requestId: frame.requestId });
      }
      case "stop_thread": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const run = this.activeRun(t);
        if (run) this.append(t, { type: "run.finished", runId: run, outcome: "interrupted", reason: "Stopped" });
        this.touch(t, { status: "idle" });
        return this.ok({ threadId: t.card.id });
      }
      case "resume_queue": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const q = this.queued(t);
        if (!this.activeRun(t) && q.length) this.startDemoRun(t, [q[0]!]);
        return this.ok({ threadId: t.card.id });
      }
      case "edit_queued":
      case "cancel_queued":
      case "promote_to_steer": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        if (!this.queued(t).includes(frame.inputId)) return this.fail("not_queued", "That message already left the queue.");
        if (frame.type === "edit_queued") this.append(t, { type: "input.changed", inputId: frame.inputId, text: frame.text });
        if (frame.type === "cancel_queued") this.append(t, { type: "input.changed", inputId: frame.inputId, cancelled: true });
        if (frame.type === "promote_to_steer") {
          this.append(t, { type: "input.changed", inputId: frame.inputId, mode: "steer" });
          const run = this.activeRun(t);
          if (run) this.append(t, { type: "input.delivered", inputId: frame.inputId, runId: run, as: "steer", outcome: "accepted" });
        }
        this.touch(t, {});
        return this.ok({ threadId: t.card.id, inputId: frame.inputId });
      }
      case "reorder_queued": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const q = this.queued(t);
        if (frame.inputIds.length !== q.length || frame.inputIds.some((id) => !q.includes(id))) return this.fail("not_queued", "The queue changed; reload it.");
        frame.inputIds.forEach((id, position) => { if (q[position] !== id) this.append(t, { type: "input.changed", inputId: id, position }); });
        this.touch(t, {});
        return this.ok({ threadId: t.card.id });
      }
      case "change_thread": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        this.append(t, { type: "thread.changed", ...(frame.modelSelection ? { modelSelection: frame.modelSelection } : {}), ...(frame.runtimeMode ? { runtimeMode: frame.runtimeMode } : {}), ...(frame.followUpMode ? { followUpMode: frame.followUpMode } : {}) });
        this.touch(t, { engine: { ...t.card.engine, ...(frame.modelSelection ? { modelSelection: frame.modelSelection } : {}), ...(frame.runtimeMode ? { runtimeMode: frame.runtimeMode } : {}) } });
        return this.ok({ threadId: t.card.id });
      }
      case "rename_thread":
      case "archive_thread": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        if (frame.type === "rename_thread") { this.append(t, { type: "thread.changed", title: frame.title }); this.touch(t, { title: frame.title }); }
        else { const archivedAt = frame.archived ? now : null; this.append(t, { type: "thread.changed", archivedAt }); this.touch(t, { archivedAt }); }
        return this.ok({ threadId: t.card.id });
      }
      case "start_thread": {
        const id = `t-${frame.clientRequestId}`;
        const card = blankCard(id, frame.kind, frame.title ?? "New thread", now, { botId: frame.botId ?? null, parent: frame.parent ? { threadId: frame.parent, byItemId: "user" } : null, model: frame.modelSelection.model, cwd: frame.cwd ?? "~" });
        const t: FakeThread = { card, lines: [] };
        this.world.threads[id] = t;
        this.append(t, { type: "thread.created", kind: frame.kind, title: card.title, projectId: null, botId: card.botId, parent: card.parent, engine: card.engine, followUpMode: card.followUpMode });
        if (frame.text) {
          const inputId = `in-${frame.clientRequestId}`;
          this.append(t, { type: "input.accepted", inputId, from: { kind: "user" }, mode: "followup", text: frame.text, clientRequestId: frame.clientRequestId });
          this.startDemoRun(t, [inputId]);
        } else this.touch(t, {});
        return this.ok({ threadId: id });
      }
      case "create_bot": {
        const botId = `bot-${frame.clientRequestId}`;
        const threadId = `t-${botId}`;
        const card = blankCard(threadId, "bot", frame.name, now, { botId, parent: null, model: frame.modelSelection.model, cwd: "~" });
        const t: FakeThread = { card, lines: [] };
        this.world.threads[threadId] = t;
        const bot: BotProfile = { botId, name: frame.name, purpose: frame.purpose, face: frame.face, role: "member", sessionThreadId: threadId, defaultModelSelection: frame.modelSelection };
        this.world.bots.push(bot);
        this.append(t, { type: "thread.created", kind: "bot", title: frame.name, projectId: null, botId, parent: null, engine: card.engine, followUpMode: "followup" });
        this.touch(t, {});
        for (const sub of this.cardSubs) this.emit({ type: "bot_changed", subId: sub, bot });
        return this.ok({ botId, threadId });
      }
      case "update_bot": {
        const i = this.world.bots.findIndex((b) => b.botId === frame.botId);
        if (i < 0) return this.unavailable("bot_not_found", "not_found", "No such bot.");
        const prev = this.world.bots[i]!;
        const bot: BotProfile = {
          ...prev,
          ...(frame.name !== undefined ? { name: frame.name } : {}),
          ...(frame.purpose !== undefined ? { purpose: frame.purpose } : {}),
          ...(frame.face !== undefined ? { face: frame.face } : {}),
          ...(frame.defaultModelSelection !== undefined ? { defaultModelSelection: frame.defaultModelSelection } : {}),
          ...(frame.instructions !== undefined ? { instructions: frame.instructions } : {}),
        };
        this.world.bots[i] = bot;
        for (const sub of this.cardSubs) this.emit({ type: "bot_changed", subId: sub, bot });
        return this.ok({ botId: bot.botId, bot });
      }
      case "get_turn_item": {
        const t = this.world.threads[frame.threadId];
        if (!t) return this.fail("thread_not_found", "No such thread.");
        const item = t.lines.flatMap((l) => (l.type === "item.completed" && l.item.id === frame.itemId ? [l.item] : []))[0];
        if (!item) return this.unavailable("item_not_found", "not_found", "No such item.");
        return this.ok({ threadId: t.card.id, turnItem: item });
      }
      // The demo host keeps no read state (the real host stores lastReadSeq in ui-state.json),
      // so mark_read is refused like the other commands it does not serve.
      case "mark_read":
      case "list_bot_notes":
      case "write_bot_notes":
      case "refresh_providers":
      case "provider_install_start":
      case "provider_install_cancel":
      case "provider_auth_respond":
      case "provider_auth_start":
      case "provider_auth_cancel":
      case "provider_auth_logout":
      case "accept_acp_registry_url_auth":
      case "search_acp_registry":
      case "prepare_acp_registry_agent":
      case "set_provider_instance":
        // Not simulated: the demo host says so instead of pretending the command worked.
        return this.unavailable("fake_host_unsupported", "unavailable", `The demo host does not serve ${frame.type}.`);
    }
  }

  private unavailable(reason: string, code: "not_found" | "unavailable", message: string): Omit<CommandResult, "reqId"> {
    return { type: "command_result", ok: false, error: { code, reason, message, retryable: false } };
  }

  // ------------------------------------------------------------ log helpers
  private append(t: FakeThread, ev: Ev) {
    const l = line((t.lines.at(-1)?.seq ?? 0) + 1, this.opts.now(), ev);
    t.lines.push(l);
    for (const [subId, threadId] of this.threadSubs) if (threadId === t.card.id) this.emit({ type: "thread_event", subId, threadId, line: l });
  }
  private touch(t: FakeThread, patch: Partial<ThreadCard>) {
    t.card = { ...t.card, ...patch, updatedAt: this.opts.now(), appliedSeq: t.lines.at(-1)?.seq ?? 0, cardSeq: ++cardSeqCounter };
    for (const sub of this.cardSubs) this.emit({ type: "card_changed", subId: sub, card: t.card });
  }
  private activeRun(t: FakeThread): string | null {
    let run: string | null = null;
    for (const l of t.lines) {
      if (l.type === "run.started") run = l.runId;
      if (l.type === "run.finished" && l.runId === run) run = null;
    }
    return run;
  }
  private openRequestIds(t: FakeThread): Set<string> {
    const open = new Set<string>();
    for (const l of t.lines) {
      if (l.type === "request.opened") open.add(l.requestId);
      if (l.type === "request.resolved") open.delete(l.requestId);
      if (l.type === "checkpoint") for (const r of l.fold.openRequests) open.add(r.requestId);
    }
    return open;
  }
  private queued(t: FakeThread): string[] {
    let q: string[] = [];
    for (const l of t.lines) {
      if (l.type === "checkpoint") q = l.fold.queuedInputs.map((x) => x.inputId);
      if (l.type === "input.accepted") q.push(l.inputId);
      if (l.type === "run.started") q = q.filter((id) => !l.inputIds.includes(id));
      if (l.type === "input.delivered" && l.outcome === "accepted") q = q.filter((id) => id !== l.inputId);
      if (l.type === "input.changed") {
        const i = q.indexOf(l.inputId);
        if (i < 0) continue;
        if (l.cancelled) { q.splice(i, 1); continue; }
        if (l.position !== undefined) { q.splice(i, 1); q.splice(Math.min(l.position, q.length), 0, l.inputId); }
      }
    }
    return q;
  }
  /** A demo run: honest about having no engine. */
  private startDemoRun(t: FakeThread, inputIds: string[]) {
    const runId = `run-${t.lines.length + 1}-${t.card.id}`;
    this.append(t, { type: "run.started", runId, inputIds, generation: 1, engineRef: null });
    this.touch(t, { status: "running" });
    setTimeout(() => {
      if (this.activeRun(t) !== runId) return;
      const at = this.opts.now();
      this.append(t, { type: "item.completed", runId, item: item(t.card.id, runId, `it-${runId}`, at, { type: "assistant_message", messageId: `m-${runId}`, text: "Demo host: no engine is connected here, so nothing ran.", streaming: false }), engineLocator: null });
      this.append(t, { type: "run.finished", runId, outcome: "completed" });
      const q = this.queued(t);
      this.touch(t, { status: "idle", latestAnswerExcerpt: "Demo host: no engine is connected here, so nothing ran." });
      if (q.length) this.startDemoRun(t, [q[0]!]);
    }, this.opts.runStepMs);
  }
}

export function blankCard(id: string, kind: ThreadCard["kind"], title: string, at: string, o: { botId: string | null; parent: ThreadCard["parent"]; model: string; cwd: string; projectId?: string | null }): ThreadCard {
  return {
    id, kind, title, projectId: o.projectId ?? null, botId: o.botId, parent: o.parent,
    engine: { providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: o.model }, runtimeMode: "full-access", cwd: o.cwd }, engineRef: null,
    status: "idle", needsYou: null, latestAnswerExcerpt: "", children: { running: 0, total: 0 }, archivedAt: null,
    followUpMode: kind === "bot" ? "followup" : "steer", updatedAt: at, epoch: "demo", appliedSeq: 0, cardSeq: ++cardSeqCounter,
  };
}
