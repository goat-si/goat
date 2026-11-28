// HostClient: owns the transport, the folded state (store.ts) and the outbox; React reads it via HostProvider.
import { apply, botRows, emptyState, emptyThread, type HostState } from "./store.ts";
import { Outbox, type OutboxStorage, type OutboxTarget } from "./outbox.ts";
import type { ConnectionState, Transport } from "./transport.ts";
import type { ClientFrame, CommandBody, CommandResult, HostFrame, InputMode, LogLine } from "./wire.ts";

export interface CacheSnapshot extends Pick<HostState, "cards" | "bots"> {
  /** Last lines of recently shown threads, so a cold start draws them at once. */
  lines?: Record<string, LogLine[]>;
}
export interface CacheStorage {
  load(): CacheSnapshot | null;
  save(snapshot: CacheSnapshot): void;
}
const CACHE_LINES = 60;

export const localStorageCache = (key = "goat2.cards.v1"): CacheStorage => ({
  load() { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
  save(s) { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* ignore */ } },
});

export interface HostSnapshot {
  state: HostState;
  connection: ConnectionState;
  /** Cards shown come from the last session's cache until cards_caught_up. */
  fromCache: boolean;
  outbox: ReturnType<Outbox["list"]>;
  /** Fake host in use (verification / demo); the UI marks it. */
  demo: string | null;
}

let seq = 0;
export const newId = () => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class HostClient {
  private transport: Transport;
  private snapshot: HostSnapshot;
  private listeners = new Set<() => void>();
  private watched = new Map<string, number>();
  private pending = new Map<string, (r: CommandResult) => void>();
  private subCounter = 0;
  readonly outbox: Outbox;
  private readonly cache: CacheStorage | null;
  commandTimeoutMs = 15000;

  constructor(transport: Transport, opts: { outbox: OutboxStorage; cache: CacheStorage | null; demo: string | null }) {
    this.transport = transport;
    this.cache = opts.cache;
    this.outbox = new Outbox(opts.outbox, newId);
    const cached = opts.cache?.load() ?? null;
    const state = emptyState();
    if (cached) {
      state.cards = cached.cards; state.bots = cached.bots;
      for (const [threadId, lines] of Object.entries(cached.lines ?? {})) {
        const card = cached.cards[threadId];
        const last = lines.at(-1);
        state.threads[threadId] = { ...emptyThread(threadId, null), lines, hasOlder: (lines[0]?.seq ?? 1) > 1,
          cursor: card && last ? { epoch: card.epoch, seq: last.seq } : null };
      }
    }
    this.snapshot = { state, connection: transport.state, fromCache: cached !== null, outbox: this.outbox.list(), demo: opts.demo };
    this.outbox.subscribe(() => this.set({ outbox: this.outbox.list() }));
    transport.onState((s) => this.onState(s));
    transport.onFrame((f) => this.onFrame(f));
    if (transport.state === "open") this.onState("open");
  }

  getSnapshot = () => this.snapshot;
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };

  private set(patch: Partial<HostSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const cb of this.listeners) cb();
  }
  private setState(state: HostState) { this.set({ state }); }

  private send(frame: ClientFrame) { this.transport.send(frame); }

  private onState(s: ConnectionState) {
    this.set({ connection: s });
    if (s === "open") {
      const cardsSubId = `cards-${++this.subCounter}`;
      let state = { ...this.snapshot.state, cardsSubId, cardsCaughtUp: false };
      // Resubscribe every watched thread from its cursor with a fresh subId (older frames become stale).
      const threads = { ...state.threads };
      for (const threadId of this.watched.keys()) {
        const prev = threads[threadId] ?? emptyThread(threadId, null);
        threads[threadId] = { ...prev, subId: `thread-${threadId}-${++this.subCounter}`, caughtUp: false, pageReqId: null };
      }
      state = { ...state, threads };
      this.setState(state);
      this.send({ type: "subscribe_cards", subId: cardsSubId, after: this.snapshot.fromCache ? null : state.cardCursor });
      for (const t of Object.values(threads)) {
        if (this.watched.has(t.threadId) && t.subId) this.send({ type: "subscribe_thread", subId: t.subId, threadId: t.threadId, after: t.cursor });
      }
    } else if (s === "closed") {
      this.outbox.onDisconnect();
      for (const [reqId, resolve] of this.pending) {
        resolve({ type: "command_result", reqId, ok: false, error: { code: "unknown_outcome", reason: "disconnected", message: "Lost the connection to the host before it answered.", retryable: true } });
      }
      this.pending.clear();
    }
  }

  private onFrame(frame: HostFrame) {
    if (frame.type === "command_result") {
      this.outbox.onResult(frame);
      const r = this.pending.get(frame.reqId);
      if (r) { this.pending.delete(frame.reqId); r(frame); }
      return;
    }
    if (frame.type === "cards_reset" && frame.subId === this.snapshot.state.cardsSubId && this.snapshot.fromCache) {
      this.set({ fromCache: false });
    }
    const { state, outgoing } = apply(this.snapshot.state, frame);
    if (state !== this.snapshot.state) this.setState(state);
    for (const f of outgoing) this.send(f);
    if (frame.type === "thread_event" && frame.line.type === "input.accepted") {
      this.outbox.onAccepted(new Set([(frame.line as Extract<LogLine, { type: "input.accepted" }>).clientRequestId]));
    }
    if (frame.type === "thread_caught_up") this.saveCache();
    if (frame.type === "cards_caught_up" && frame.subId === this.snapshot.state.cardsSubId) {
      this.set({ fromCache: false });
      this.saveCache();
      this.flushOutbox();
    }
  }

  private saveCache() {
    if (!this.cache) return;
    const lines: Record<string, LogLine[]> = {};
    for (const t of Object.values(this.snapshot.state.threads)) if (t.lines.length) lines[t.threadId] = t.lines.slice(-CACHE_LINES);
    this.cache.save({ cards: this.snapshot.state.cards, bots: this.snapshot.state.bots, lines });
  }

  resolveTarget = (t: OutboxTarget): string | null => {
    if (t.threadId) return t.threadId;
    if (t.botId) {
      const bot = this.snapshot.state.bots[t.botId];
      if (bot) return bot.sessionThreadId;
      const row = botRows(this.snapshot.state).find((r) => r.botId === t.botId);
      return row?.threadId ?? null;
    }
    return null;
  };

  private flushOutbox() {
    if (this.snapshot.connection !== "open" || !this.snapshot.state.cardsCaughtUp) return;
    this.outbox.flush(this.resolveTarget, (f) => this.send(f));
  }

  /** Send a message: shows at once (outbox), goes out once the socket is up. */
  sendMessage(target: OutboxTarget, text: string, mode: InputMode) {
    this.outbox.add(target, text, mode);
    this.flushOutbox();
  }
  resend(clientRequestId: string) {
    const open = this.snapshot.connection === "open" && this.snapshot.state.cardsCaughtUp;
    this.outbox.resend(clientRequestId, open, this.resolveTarget, (f) => this.send(f));
  }
  discard(clientRequestId: string) { this.outbox.remove(clientRequestId); }

  /** Any other command; resolves with its command_result (or a local failure when not connected). */
  command<T extends CommandBody>(body: T, clientRequestId = newId()): Promise<CommandResult> {
    const reqId = newId();
    if (this.snapshot.connection !== "open") {
      return Promise.resolve({ type: "command_result", reqId, ok: false, error: { code: "unavailable", reason: "not_connected", message: "Not connected to the host.", retryable: true } });
    }
    return new Promise((resolve) => {
      // An open socket with no answer: report an unknown outcome after a bound; never retry by itself.
      const timer = setTimeout(() => {
        if (!this.pending.delete(reqId)) return;
        resolve({ type: "command_result", reqId, ok: false, error: { code: "unknown_outcome", reason: "no_answer", message: "No answer from the host yet; it may still apply. Check before trying again.", retryable: false } });
      }, this.commandTimeoutMs);
      this.pending.set(reqId, (r) => { clearTimeout(timer); resolve(r); });
      this.send({ ...body, reqId, clientRequestId } as unknown as ClientFrame);
    });
  }

  /** Subscribe to a thread while at least one view shows it. */
  watchThread(threadId: string): () => void {
    const n = this.watched.get(threadId) ?? 0;
    this.watched.set(threadId, n + 1);
    if (n === 0) {
      const subId = `thread-${threadId}-${++this.subCounter}`;
      const prev = this.snapshot.state.threads[threadId];
      const view = prev ? { ...prev, subId, caughtUp: false } : emptyThread(threadId, subId);
      this.setState({ ...this.snapshot.state, threads: { ...this.snapshot.state.threads, [threadId]: view } });
      if (this.snapshot.connection === "open") this.send({ type: "subscribe_thread", subId, threadId, after: view.cursor });
    }
    return () => {
      const m = (this.watched.get(threadId) ?? 1) - 1;
      if (m > 0) { this.watched.set(threadId, m); return; }
      this.watched.delete(threadId);
      const t = this.snapshot.state.threads[threadId];
      if (t?.subId && this.snapshot.connection === "open") this.send({ type: "unsubscribe", subId: t.subId });
      if (t) this.setState({ ...this.snapshot.state, threads: { ...this.snapshot.state.threads, [threadId]: { ...t, subId: null } } });
    };
  }

  /** Scroll-back: one page of older lines. */
  readOlder(threadId: string, limit = 50) {
    const t = this.snapshot.state.threads[threadId];
    if (!t || !t.hasOlder || t.pageReqId || this.snapshot.connection !== "open") return;
    const before = t.lines[0]?.seq ?? 1;
    const reqId = newId();
    this.setState({ ...this.snapshot.state, threads: { ...this.snapshot.state.threads, [threadId]: { ...t, pageReqId: reqId } } });
    this.send({ type: "read_page", reqId, threadId, before, limit });
  }

  close() { this.transport.close(); }
}
