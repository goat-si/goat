// Send-first outbox (structure/30_wire.md "UI outbox", owner 2026-11-28; plan 020 Revision 1 + 5).
// Entries are keyed by clientRequestId and persisted before anything is sent. Never resent automatically.
import type { ClientFrame, CommandResult, InputMode } from "./wire.ts";

export type OutboxStatus = "queued" | "sending" | "confirmed" | "unconfirmed" | "failed";
export interface OutboxTarget { botId?: string; threadId?: string }
export interface OutboxEntry {
  clientRequestId: string;
  target: OutboxTarget;
  text: string;
  mode: InputMode;
  /** Every reqId used for this entry; a result carrying any of them settles it. */
  reqIds: string[];
  status: OutboxStatus;
  error: string | null;
  createdAt: string;
}

export interface OutboxStorage {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

export const memoryStorage = (initial: OutboxEntry[] = []): OutboxStorage & { saved: OutboxEntry[] } => {
  const s = { saved: initial.map((e) => ({ ...e })), load: () => s.saved.map((e) => ({ ...e })), save: (e: OutboxEntry[]) => { s.saved = e.map((x) => ({ ...x })); } };
  return s;
};

export const localStorageOutbox = (key = "goat2.outbox.v1"): OutboxStorage => ({
  load() {
    try { return JSON.parse(localStorage.getItem(key) ?? "[]") as OutboxEntry[]; } catch { return []; }
  },
  save(entries) {
    try { localStorage.setItem(key, JSON.stringify(entries)); } catch { /* storage full or blocked: entries stay in memory */ }
  },
});

export class Outbox {
  private entries: OutboxEntry[];
  private listeners = new Set<() => void>();
  private readonly storage: OutboxStorage;
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(storage: OutboxStorage, newId: () => string, now: () => string = () => new Date().toISOString()) {
    this.storage = storage;
    this.newId = newId;
    this.now = now;
    // A reload while sending means the result may be lost: never guess, ask the person.
    this.entries = storage.load().map((e) => (e.status === "sending" ? { ...e, status: "unconfirmed" as const } : e));
    this.persist();
  }

  list(): readonly OutboxEntry[] { return this.entries; }
  subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  private persist() {
    this.storage.save(this.entries);
    for (const cb of this.listeners) cb();
  }
  private update(id: string, f: (e: OutboxEntry) => OutboxEntry | null) {
    const next: OutboxEntry[] = [];
    for (const e of this.entries) {
      if (e.clientRequestId !== id) { next.push(e); continue; }
      const u = f(e);
      if (u) next.push(u);
    }
    this.entries = next;
    this.persist();
  }

  add(target: OutboxTarget, text: string, mode: InputMode): OutboxEntry {
    const entry: OutboxEntry = { clientRequestId: this.newId(), target, text, mode, reqIds: [], status: "queued", error: null, createdAt: this.now() };
    this.entries = [...this.entries, entry];
    this.persist();
    return entry;
  }

  /** Send every queued entry whose target resolves to a thread. Each entry is persisted as sending first. */
  flush(resolveThread: (t: OutboxTarget) => string | null, send: (f: ClientFrame) => void) {
    for (const e of [...this.entries]) {
      if (e.status !== "queued") continue;
      const threadId = resolveThread(e.target);
      if (!threadId) continue;
      this.sendEntry(e, threadId, send);
    }
  }

  private sendEntry(e: OutboxEntry, threadId: string, send: (f: ClientFrame) => void) {
    const reqId = this.newId();
    this.update(e.clientRequestId, (x) => ({ ...x, target: { ...x.target, threadId }, reqIds: [...x.reqIds, reqId], status: "sending", error: null }));
    send({ type: "send_input", reqId, clientRequestId: e.clientRequestId, threadId, text: e.text, mode: e.mode });
  }

  /** command_result for any reqId of an entry. Results for unknown reqIds are ignored. */
  onResult(result: CommandResult) {
    const e = this.entries.find((x) => x.reqIds.includes(result.reqId));
    if (!e || e.status === "confirmed") return;
    if (result.ok) this.update(e.clientRequestId, (x) => ({ ...x, status: "confirmed", error: null }));
    else this.update(e.clientRequestId, (x) => ({ ...x, status: "failed", error: result.error?.message ?? "The host refused this message." }));
  }

  /** input.accepted lines seen in a thread: those entries are in the log now and render from it. */
  onAccepted(clientRequestIds: ReadonlySet<string>) {
    if (!this.entries.some((e) => clientRequestIds.has(e.clientRequestId))) return;
    this.entries = this.entries.filter((e) => !clientRequestIds.has(e.clientRequestId));
    this.persist();
  }

  /** Socket dropped: anything without a result is not confirmed. */
  onDisconnect() {
    if (!this.entries.some((e) => e.status === "sending")) return;
    this.entries = this.entries.map((e) => (e.status === "sending" ? { ...e, status: "unconfirmed" } : e));
    this.persist();
  }

  /** Explicit Resend: same clientRequestId (the host dedupes), new reqId. */
  resend(id: string, connected: boolean, resolveThread: (t: OutboxTarget) => string | null, send: (f: ClientFrame) => void) {
    const e = this.entries.find((x) => x.clientRequestId === id);
    if (!e || (e.status !== "unconfirmed" && e.status !== "failed")) return;
    const threadId = resolveThread(e.target);
    if (!connected || !threadId) { this.update(id, (x) => ({ ...x, status: "queued", error: null })); return; }
    this.sendEntry(e, threadId, send);
  }

  remove(id: string) { this.update(id, () => null); }
}
