// Pure folds over host frames (structure/30_wire.md, crates/goat2-contracts subscribe.rs + log.rs).
// No I/O here: HostClient feeds frames in and sends whatever `apply` asks for (resync_item).
import type {
  BotProfile, CardCursor, ClientFrame, Fold, HostFrame, LogLine, QueuedInput, RequestOpened, ThreadCard,
  ThreadCursor, TurnItem,
} from "./wire.ts";

export interface ThreadView {
  threadId: string;
  /** Current subscription id; frames from older subscriptions are dropped. */
  subId: string | null;
  caughtUp: boolean;
  cursor: ThreadCursor | null;
  /** Finished log lines, ascending by seq, no duplicates. */
  lines: LogLine[];
  /** True when lines before the first one exist (replay started at a checkpoint). */
  hasOlder: boolean;
  /** reqId of the read_page in flight, if any; other page answers are stale. */
  pageReqId: string | null;
  /** Live text for unfinished items, by itemId (UTF-16 lengths match the host offsets). */
  streaming: Record<string, string>;
  /** Fold restored from the latest checkpoint line, if the replay started there. */
  checkpointFold: Fold | null;
}

export interface HostState {
  cardsSubId: string | null;
  cardsCaughtUp: boolean;
  cardCursor: CardCursor | null;
  cards: Record<string, ThreadCard>;
  bots: Record<string, BotProfile>;
  threads: Record<string, ThreadView>;
}

export const emptyState = (): HostState => ({
  cardsSubId: null, cardsCaughtUp: false, cardCursor: null, cards: {}, bots: {}, threads: {},
});

export const emptyThread = (threadId: string, subId: string | null): ThreadView => ({
  threadId, subId, caughtUp: false, cursor: null, lines: [], hasOlder: false, pageReqId: null,
  streaming: {}, checkpointFold: null,
});

/** Merge lines by seq (dedupe, ascending). */
export function mergeLines(a: LogLine[], b: LogLine[]): LogLine[] {
  const bySeq = new Map<number, LogLine>();
  for (const l of a) bySeq.set(l.seq, l);
  for (const l of b) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export interface ApplyResult {
  state: HostState;
  /** Frames the client must send in response (resync_item). */
  outgoing: ClientFrame[];
}

function withThread(state: HostState, threadId: string, f: (t: ThreadView) => ThreadView): HostState {
  const cur = state.threads[threadId];
  if (!cur) return state;
  return { ...state, threads: { ...state.threads, [threadId]: f(cur) } };
}

/** Apply one host frame. Frames for a subscription that is not current are ignored. */
export function apply(state: HostState, frame: HostFrame): ApplyResult {
  const none = (s: HostState): ApplyResult => ({ state: s, outgoing: [] });
  switch (frame.type) {
    case "cards_reset":
      if (frame.subId !== state.cardsSubId) return none(state);
      return none({ ...state, cards: {}, bots: {}, cardsCaughtUp: false, cardCursor: null });
    case "card_changed": {
      if (frame.subId !== state.cardsSubId) return none(state);
      const prev = state.cards[frame.card.id];
      if (prev && prev.cardSeq > frame.card.cardSeq) return none(state);
      return none({ ...state, cards: { ...state.cards, [frame.card.id]: frame.card } });
    }
    case "card_removed": {
      if (frame.subId !== state.cardsSubId) return none(state);
      const { [frame.threadId]: _gone, ...rest } = state.cards;
      return none({ ...state, cards: rest });
    }
    case "cards_caught_up":
      if (frame.subId !== state.cardsSubId) return none(state);
      return none({ ...state, cardsCaughtUp: true, cardCursor: frame.cursor });
    case "bot_changed":
      if (frame.subId !== state.cardsSubId) return none(state);
      return none({ ...state, bots: { ...state.bots, [frame.bot.botId]: frame.bot } });
    case "bot_removed": {
      if (frame.subId !== state.cardsSubId) return none(state);
      const { [frame.botId]: _gone, ...rest } = state.bots;
      return none({ ...state, bots: rest });
    }
    case "thread_reset":
      if (state.threads[frame.threadId]?.subId !== frame.subId) return none(state);
      return none(withThread(state, frame.threadId, (t) => ({ ...emptyThread(t.threadId, t.subId) })));
    case "thread_event": {
      const t = state.threads[frame.threadId];
      if (!t || t.subId !== frame.subId) return none(state);
      const line = frame.line;
      return none(withThread(state, frame.threadId, (v) => {
        const next: ThreadView = { ...v, lines: mergeLines(v.lines, [line]) };
        if (line.type === "checkpoint") {
          // Replay after a reset starts here; earlier lines are only reachable by read_page.
          if (v.lines.length === 0) next.hasOlder = line.seq > 1;
          next.checkpointFold = line.fold;
        }
        if (line.type === "item.completed" && next.streaming[line.item.id] !== undefined) {
          const { [line.item.id]: _done, ...rest } = next.streaming;
          next.streaming = rest;
        }
        return next;
      }));
    }
    case "thread_caught_up": {
      const t = state.threads[frame.threadId];
      if (!t || t.subId !== frame.subId) return none(state);
      return none(withThread(state, frame.threadId, (v) => ({ ...v, caughtUp: true, cursor: frame.cursor })));
    }
    case "page": {
      const t = state.threads[frame.threadId];
      if (!t || t.pageReqId !== frame.reqId) return none(state);
      return none(withThread(state, frame.threadId, (v) => ({
        ...v, lines: mergeLines(frame.lines, v.lines), hasOlder: frame.hasMore, pageReqId: null,
      })));
    }
    case "text_append": {
      const t = state.threads[frame.threadId];
      if (!t || t.subId !== frame.subId) return none(state);
      const have = t.streaming[frame.itemId] ?? "";
      if (frame.offset === 0) {
        return none(withThread(state, frame.threadId, (v) => ({ ...v, streaming: { ...v.streaming, [frame.itemId]: frame.text } })));
      }
      if (frame.offset !== have.length) {
        return { state, outgoing: [{ type: "resync_item", subId: frame.subId, itemId: frame.itemId }] };
      }
      return none(withThread(state, frame.threadId, (v) => ({ ...v, streaming: { ...v.streaming, [frame.itemId]: have + frame.text } })));
    }
    case "providers":
      // Provider instances belong to the providers UI (goat2_providers_ui); the thread store ignores them.
      return none(state);
    case "ping":
      return { state, outgoing: [{ type: "pong", at: frame.at }] };
    case "error":
    case "command_result":
      return none(state);
  }
}

// ---------------------------------------------------------------- derived views

export interface TranscriptUser { kind: "user"; key: string; inputId: string; text: string; at: string; clientRequestId: string; source: "user" | "system" | "child" }
export interface TranscriptBot { kind: "bot"; key: string; text: string; at: string; streaming: boolean }
export interface WorkStep { key: string; verb: string; detail: string; extra?: string; status: TurnItem["status"] }
export interface TranscriptWork { kind: "work"; key: string; runId: string; startedAt: string; finishedAt: string | null; outcome: string | null; steps: WorkStep[] }
export interface TranscriptChild { kind: "child"; key: string; childThreadId: string; task: string; at: string; reported: { status: string; summary: string; at: string } | null }
export type TranscriptEntry = TranscriptUser | TranscriptBot | TranscriptWork | TranscriptChild;

export interface DerivedThread {
  entries: TranscriptEntry[];
  openRequests: RequestOpened[];
  /** Inputs accepted but not delivered, in queue order (v1 queue parity). */
  queued: QueuedInput[];
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  /** clientRequestIds seen in input.accepted (settles outbox entries). */
  acceptedClientRequestIds: Set<string>;
  lastRun: { startedAt: string; finishedAt: string | null; outcome: string | null } | null;
  /** Waiting approval_request / user_input_request items by requestId (the choices to render). */
  requestItems: Record<string, TurnItem>;
}

function toolStep(item: TurnItem): WorkStep | null {
  const base = { key: item.id, status: item.status };
  switch (item.type) {
    case "command_execution": {
      const failing = item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0);
      return { ...base, verb: "Ran", detail: item.title ?? item.input, ...(failing ? { extra: "failed" } : {}) };
    }
    case "file_change": {
      const diff = item.additions !== undefined || item.deletions !== undefined
        ? `+${item.additions ?? 0} −${item.deletions ?? 0}` : undefined;
      return { ...base, verb: "Edited", detail: item.fileName, ...(diff ? { extra: diff } : {}) };
    }
    case "web_search":
      return { ...base, verb: "Searched", detail: item.title ?? (item.patterns ?? []).join(", ") };
    case "dynamic_tool":
      return { ...base, verb: item.toolName ?? "Tool", detail: item.toolSummary ?? item.title ?? "" };
    case "subagent":
      return { ...base, verb: "Started", detail: item.title ?? item.prompt };
    default:
      return null;
  }
}

export function deriveThread(view: ThreadView | undefined): DerivedThread {
  const out: DerivedThread = {
    entries: [], openRequests: [], queued: [], activeRunId: null, activeRunStartedAt: null,
    acceptedClientRequestIds: new Set(), lastRun: null, requestItems: {},
  };
  if (!view) return out;
  const requests = new Map<string, RequestOpened>();
  // Queue state: start from the checkpoint fold, then fold later lines.
  let queue: QueuedInput[] = [];
  const delivered = new Set<string>();
  const accepted = new Map<string, { text: string; at: string; clientRequestId: string; source: TranscriptUser["source"] }>();
  const shown = new Set<string>();
  const works = new Map<string, TranscriptWork>();
  const children = new Map<string, TranscriptChild>();
  const fold = view.checkpointFold;
  const firstSeq = view.lines[0]?.seq ?? 0;
  for (const line of view.lines) {
    if (line.type === "checkpoint") {
      // A checkpoint carries the fold as of its seq; it replaces anything folded so far for these fields.
      queue = [...line.fold.queuedInputs];
      for (const r of line.fold.openRequests) requests.set(r.requestId, r);
      out.activeRunId = line.fold.activeRunId;
      continue;
    }
    switch (line.type) {
      case "input.accepted": {
        const source = line.from.kind;
        accepted.set(line.inputId, { text: line.text, at: line.at, clientRequestId: line.clientRequestId, source });
        out.acceptedClientRequestIds.add(line.clientRequestId);
        if (!queue.some((q) => q.inputId === line.inputId)) {
          queue.push({ inputId: line.inputId, text: line.text, mode: line.mode, source: line.from, ...(line.attachments ? { attachments: line.attachments } : {}) });
        }
        break;
      }
      case "input.changed": {
        const i = queue.findIndex((q) => q.inputId === line.inputId);
        if (i < 0) break;
        if (line.cancelled) { queue.splice(i, 1); break; }
        const q = { ...queue[i]! };
        if (line.text !== undefined) { q.text = line.text; const a = accepted.get(q.inputId); if (a) a.text = line.text; }
        if (line.mode !== undefined) q.mode = line.mode;
        queue.splice(i, 1);
        const pos = line.position !== undefined ? Math.max(0, Math.min(line.position, queue.length)) : i;
        queue.splice(pos, 0, q);
        break;
      }
      case "input.delivered":
        if (line.outcome === "accepted") delivered.add(line.inputId);
        break;
      case "run.started": {
        out.activeRunId = line.runId;
        out.activeRunStartedAt = line.at;
        for (const id of line.inputIds) delivered.add(id);
        works.set(line.runId, { kind: "work", key: `work-${line.runId}`, runId: line.runId, startedAt: line.at, finishedAt: null, outcome: null, steps: [] });
        break;
      }
      case "run.finished": {
        if (out.activeRunId === line.runId) { out.activeRunId = null; out.activeRunStartedAt = null; }
        const w = works.get(line.runId);
        if (w) { w.finishedAt = line.at; w.outcome = line.outcome; out.lastRun = { startedAt: w.startedAt, finishedAt: line.at, outcome: line.outcome }; }
        break;
      }
      case "item.completed": {
        const item = line.item;
        if (item.type === "approval_request" || item.type === "user_input_request") {
          out.requestItems[item.requestId] = item;
          break;
        }
        if (item.type === "assistant_message") {
          out.entries.push({ kind: "bot", key: item.id, text: item.text, at: line.at, streaming: false });
        } else {
          const step = toolStep(item);
          const w = works.get(line.runId);
          if (step && w) {
            if (!out.entries.includes(w)) out.entries.push(w);
            w.steps.push(step);
          }
        }
        break;
      }
      case "request.opened":
        requests.set(line.requestId, line);
        break;
      case "request.resolved":
        requests.delete(line.requestId);
        break;
      case "child.started": {
        const c: TranscriptChild = { kind: "child", key: `child-${line.childThreadId}`, childThreadId: line.childThreadId, task: line.task, at: line.at, reported: null };
        children.set(line.childThreadId, c);
        out.entries.push(c);
        break;
      }
      case "child.reported": {
        const c = children.get(line.childThreadId);
        if (c) c.reported = { status: line.status, summary: line.summary, at: line.at };
        break;
      }
      default:
        break;
    }
    // A user/system input shows in the transcript once it reached a run.
    for (const [id, a] of accepted) {
      if (!shown.has(id) && delivered.has(id)) {
        shown.add(id);
        queue = queue.filter((q) => q.inputId !== id);
        const entry: TranscriptUser = { kind: "user", key: id, inputId: id, text: a.text, at: a.at, clientRequestId: a.clientRequestId, source: a.source };
        out.entries.push(entry);
      }
    }
  }
  if (fold && firstSeq > 0 && view.lines.every((l) => l.type !== "checkpoint")) {
    queue = [...fold.queuedInputs];
  }
  // Streaming text for unfinished items goes last, as a live bot entry.
  for (const [itemId, text] of Object.entries(view.streaming)) {
    out.entries.push({ kind: "bot", key: `stream-${itemId}`, text, at: "", streaming: true });
  }
  out.openRequests = [...requests.values()];
  out.queued = queue.filter((q) => !delivered.has(q.inputId));
  return out;
}

// ---------------------------------------------------------------- roster

export type BotState = "needs-you" | "working" | "idle";
export interface BotRowData {
  botId: string;
  threadId: string | null;
  name: string;
  purpose: string;
  face: BotProfile["face"] | null;
  role: "main" | "member";
  state: BotState;
  line: string;
  updatedAt: string | null;
  card: ThreadCard | null;
}

export function botRows(state: HostState): BotRowData[] {
  const cardsByBot = new Map<string, ThreadCard>();
  for (const c of Object.values(state.cards)) if (c.kind === "bot" && c.botId) cardsByBot.set(c.botId, c);
  const ids = new Set<string>([...Object.keys(state.bots), ...cardsByBot.keys()]);
  const rows: BotRowData[] = [];
  for (const botId of ids) {
    const bot = state.bots[botId];
    const card = (bot ? state.cards[bot.sessionThreadId] : undefined) ?? cardsByBot.get(botId) ?? null;
    const st: BotState = card?.status === "needs_you" ? "needs-you" : card?.status === "running" || card?.status === "queued" ? "working" : "idle";
    rows.push({
      botId,
      threadId: bot?.sessionThreadId ?? card?.id ?? null,
      name: bot?.name ?? card?.title ?? botId,
      purpose: bot?.purpose ?? "",
      face: bot?.face ?? null,
      role: bot?.role ?? (botId === "main" ? "main" : "member"),
      state: st,
      line: card?.needsYou?.summary ?? card?.latestAnswerExcerpt ?? "",
      updatedAt: card?.updatedAt ?? null,
      card,
    });
  }
  return rows;
}

/** Worker threads started by a thread (cards whose parent is that thread), newest first. */
export function workerThreads(state: HostState, parentThreadId: string): ThreadCard[] {
  return Object.values(state.cards)
    .filter((c) => c.parent?.threadId === parentThreadId && !c.archivedAt)
    .sort((a, b) => (a.status === "running" ? -1 : 0) - (b.status === "running" ? -1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
}
