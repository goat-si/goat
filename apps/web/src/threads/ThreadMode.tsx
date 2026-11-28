// Thread mode (T0 1N65-1, T1 1NEM-1, T4 1OXX-1). The boards were redrawn from GOAT v1 code
// (origin/dev 916b5ccc: Sidebar Activity view, ChatHeader, MessagesTimeline, TimelineWorkGroupRows, WorkLog,
// TurnFoldLabel, ChatComposer/ComposerSurface, QueuedRunsControl), so the generated parts carry v1's
// resolved look; this file maps GOAT 2 data onto them.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import * as P from "../paper/parts.tsx";
import { useClient, useHost, useHostContext, useThread } from "../host/HostProvider.tsx";
import type { ThreadCard } from "../host/wire.ts";
import type { TranscriptEntry, WorkStep } from "../host/store.ts";
import { plannedProps } from "../planned/Planned.tsx";
import type { UiState } from "../ui-state/uiState.ts";
import { duration } from "../lib/format.ts";

const btn = (label: string, onClick: () => void, extra: P.El = {}): P.El => ({
  role: "button", tabIndex: 0, "aria-label": label, onClick, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }, ...extra,
});
const project = (c: ThreadCard) => c.projectId ?? c.engine.cwd.split("/").filter(Boolean).at(-1) ?? "";

function useTicker(active: boolean) {
  const [, setN] = useState(0);
  useEffect(() => { if (!active) return; const t = setInterval(() => setN((n) => n + 1), 1000); return () => clearInterval(t); }, [active]);
}

export function ThreadMode({ ui, setUi, rail, lights, stamp, toggleSidebar }: {
  ui: UiState; setUi: (p: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => void; rail: ReactNode; lights: ReactNode; stamp: ReactNode; toggleSidebar: () => void;
}) {
  const snap = useHost();
  const { now } = useHostContext();
  const cards = Object.values(snap.state.cards).filter((c) => c.kind !== "bot" && !c.archivedAt);
  const unread = (c: ThreadCard) => c.id !== ui.threadId && ui.readMarks[c.id] !== undefined && c.updatedAt > ui.readMarks[c.id]!;
  const priority = cards.filter((c) => c.status === "needs_you").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const working = cards.filter((c) => (c.status === "running" || c.status === "queued") && c.id !== ui.threadId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const rest = cards.filter((c) => !priority.includes(c) && !working.includes(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = ui.threadId ? snap.state.cards[ui.threadId] ?? null : null;
  const [workingOpen, setWorkingOpen] = useState(true);
  const open = (id: string) => setUi((s) => ({ threadId: id, readMarks: { ...s.readMarks, [id]: new Date().toISOString() } }));
  useTicker(working.length > 0);

  const status = (c: ThreadCard): ReactNode => {
    if (c.needsYou) {
      const k = c.needsYou.kind;
      return k === "question" || k === "signin" ? <P.TlsInput label={k === "signin" ? "Sign in" : "Input"} /> : <P.TlsApproval label={k === "decision" ? "Decision" : k === "resend" ? "Resend" : "Approval"} />;
    }
    if (c.status === "failed") return <P.TlsFailed />;
    if (unread(c)) return <P.TlsDot />;
    return null;
  };
  const row = (c: ThreadCard) => {
    const props = { icon: <P.TlsIcon />, title: c.title, status: status(c), project: project(c), right: null,
      root: btn(c.title, () => open(c.id), { "data-thread-row": c.id, "aria-current": ui.threadId === c.id ? "page" : undefined }) };
    return ui.threadId === c.id ? <P.TlsRowSelected key={c.id} {...props} /> : <P.TlsRow key={c.id} {...props} />;
  };
  const sidebar = ui.sidebarOpen ? (
    <P.ThreadSidebarCol
      top={<>
        <P.ThreadSidebarTop toggle={btn("GOAT", () => setUi({ mode: "bots" }))} back={btn("Back", () => history.back())} forward={btn("Forward", () => history.forward())}
          bell={plannedProps("notifications")} count={null} />
        {(!snap.state.cardsCaughtUp || snap.fromCache) && <P.UpdatingLine text={snap.connection === "closed" ? "Not connected to GOAT host" : "Updating"} />}
      </>}
      search={<P.ThreadSidebarSearch search={plannedProps("search")} compose={btn("New thread", () => setUi({ threadId: null }), { title: "New thread" })} />}
      list={<P.ThreadList>
        {priority.length > 0 && <P.TlsSection label={`Priority (${priority.length})`} />}
        {priority.map(row)}
        {rest.length > 0 && <P.TlsSectionThreads label="Threads" />}
        {rest.map(row)}
        <P.TlsSpacer />
        {working.length > 0 && <P.TlsWorkingHeader count={working.length} root={btn(workingOpen ? "Collapse Working" : "Expand Working", () => setWorkingOpen((v) => !v), { "aria-expanded": workingOpen })} />}
        {workingOpen && working.map((c) => (
          <P.TlsWorkingRow key={c.id} title={c.title} time={duration(c.updatedAt, now().toISOString()).replace(/ \d+s$/, "")}
            root={btn(c.title, () => open(c.id), { "data-thread-row": c.id })} />
        ))}
      </P.ThreadList>}
    />
  ) : null;
  return (
    <P.ThreadFrame rail={rail} lights={lights} sidebar={sidebar} stamp={stamp}
      toggle={btn("Toggle main sidebar (⌘B)", toggleSidebar, { title: "Toggle main sidebar (⌘B)" })}
      menu={plannedProps("thread-filters")} bottom={plannedProps("terminal-lens")} panel={plannedProps("multiplexer")}
      header={selected ? <P.ThreadHeader icon={<ProviderGlyph driver="codex" size={12} />} project={project(selected)} title={selected.title} /> : null}
      main={<ThreadColumn card={selected} onStarted={(id) => open(id)} />} />
  );
}

function stepRow(s: WorkStep) {
  const text = `${s.verb} ${s.detail}`.trim();
  if (s.verb === "Edited") {
    const m = /^\+(\d+) −(\d+)$/.exec(s.extra ?? "");
    return <P.TlRowEdited key={s.key} text={text} add={m ? `+${m[1]}` : ""} del={m ? `-${m[2]}` : ""} />;
  }
  if (s.extra === "failed") return <P.TlRowFailed key={s.key} text={`Failed ${s.detail}`} />;
  if (s.verb === "Explored" || s.verb === "Read" || s.verb === "Searched") return <P.TlRowExplored key={s.key} text={text} />;
  return <P.TlRowRan key={s.key} text={text} />;
}

export function WorkFold({ e, nowIso }: { e: Extract<TranscriptEntry, { kind: "work" }>; nowIso: string }) {
  const [open, setOpen] = useState(true);
  if (e.finishedAt === null) {
    const last = e.steps.at(-1);
    return <>
      <P.TlWorking label={`Working for ${duration(e.startedAt, nowIso)}`} />
      {e.steps.slice(0, -1).map(stepRow)}
      {last && <P.TlRowRunning text={`Running ${last.detail}`} />}
    </>;
  }
  const label = e.outcome === "interrupted" ? `You stopped after ${duration(e.startedAt, e.finishedAt)}` : `Worked for ${duration(e.startedAt, e.finishedAt)}`;
  return <>
    <P.TlFold label={label} open={open} root={btn(open ? "Collapse work" : "Expand work", () => setOpen((v) => !v), { "aria-expanded": open })} />
    {open && e.steps.map(stepRow)}
  </>;
}

export function TimelineEntries({ entries, activeRunStartedAt, nowIso }: { entries: TranscriptEntry[]; activeRunStartedAt: string | null; nowIso: string }) {
  const out: ReactNode[] = [];
  for (const e of entries) {
    if (e.kind === "user") out.push(<P.TlUser key={e.key} text={e.text} />);
    else if (e.kind === "work") out.push(<WorkFold key={e.key} e={e} nowIso={nowIso} />);
    else if (e.kind === "bot") out.push(<P.TlAnswer key={e.key} text={e.text} />);
  }
  // A run with no finished step yet still shows that it is working (v1 WorkingTimelineRow).
  if (activeRunStartedAt && !entries.some((e) => e.kind === "work" && e.finishedAt === null)) {
    out.push(<P.TlWorking key="working" label={`Working for ${duration(activeRunStartedAt, nowIso)}`} />);
  }
  return <>{out}</>;
}

function ThreadColumn({ card, onStarted }: { card: ThreadCard | null; onStarted: (id: string) => void }) {
  const client = useClient();
  const { now } = useHostContext();
  const thread = useThread(card?.id ?? null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(true);
  const running = thread.activeRunId !== null;
  useTicker(running);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [thread.entries.length]);
  const run = async (body: Parameters<typeof client.command>[0]) => {
    setError(null);
    const r = await client.command(body);
    if (!r.ok) setError(r.error?.message ?? "The host did not take this.");
    return r;
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    if (editing && card) {
      const r = await run({ type: "edit_queued", threadId: card.id, inputId: editing, text });
      if (r.ok) { setEditing(null); setDraft(""); }
      return;
    }
    if (card) { client.sendMessage({ threadId: card.id }, text, card.followUpMode === "followup" ? "followup" : "steer"); setDraft(""); return; }
    const r = await run({ type: "start_thread", kind: "user", title: text.slice(0, 80), modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, runtimeMode: "full-access", text });
    if (r.ok && r.value?.threadId) { setDraft(""); onStarted(r.value.threadId); }
  };
  const queued = card ? thread.queued : [];
  const banner = queued.length > 0 ? (
    <P.QueueBanner count={queued.length} header={btn(queueOpen ? "Collapse queued messages" : "Expand queued messages", () => setQueueOpen((v) => !v), { "aria-expanded": queueOpen })}
      rows={queueOpen ? queued.map((q, i) => (
        <P.QueueRow key={q.inputId} text={q.text} steerLabel={running ? "Steer" : "Send now"}
          grip={{ "aria-label": "Reorder queued message (arrow keys)", tabIndex: 0, role: "button", onKeyDown: (e) => {
            const ids = queued.map((x) => x.inputId);
            const j = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
            if (j < 0 || j >= ids.length || !card) return;
            e.preventDefault(); [ids[i], ids[j]] = [ids[j]!, ids[i]!];
            void run({ type: "reorder_queued", threadId: card.id, inputIds: ids });
          } }}
          edit={btn("Edit queued message", () => { setEditing(q.inputId); setDraft(q.text); })}
          steer={btn(running ? "Steer now" : "Send now", () => card && void run(running ? { type: "promote_to_steer", threadId: card.id, inputId: q.inputId } : { type: "resume_queue", threadId: card.id }))}
          remove={btn("Delete queued message", () => card && void run({ type: "cancel_queued", threadId: card.id, inputId: q.inputId }))} />
      )) : null} />
  ) : null;
  const sendButton = running && card
    ? <P.ComposerStop button={btn("Stop", () => void run({ type: "stop_thread", threadId: card.id }))} />
    : <div {...(btn(editing ? "Save queued message" : "Send", () => void submit()) as object)} data-send=""
        style={{ alignItems: "center", backgroundColor: draft.trim() ? "#0D0D0D" : "#0D0D0D33", borderRadius: 9999, display: "flex", height: 28, justifyContent: "center", width: 28, flexShrink: 0 }}>
        <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>;
  return (
    <P.ThreadMain
      timeline={<div ref={scroller} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {card ? <P.Timeline root={{ "data-timeline": card.id }}>
          <TimelineEntries entries={thread.entries} activeRunStartedAt={thread.activeRunStartedAt} nowIso={now().toISOString()} />
        </P.Timeline> : null}
      </div>}
      composer={<>
        {(error || editing) && <div role={error ? "alert" : undefined} style={{ maxWidth: 672, margin: "0 auto 6px", padding: "0 48px", color: "#5D5D5D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 12 }}>
          {error ?? <>Editing a queued message · <span {...(btn("Cancel editing", () => { setEditing(null); setDraft(""); }) as object)} style={{ textDecoration: "underline" }}>Cancel</span></>}
        </div>}
        <P.ThreadComposer banner={banner}
          input={<textarea className="goat2-input" rows={2} value={draft} placeholder="Ask anything. @ files, $ skills, / commands" aria-label="Message"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
            style={{ color: "#0D0D0D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 14, lineHeight: "22px" }} />}
          plus={plannedProps("attachments")} access={plannedProps("settings-accounts")} spinner={running ? <span data-spin="" style={{ display: "inline-flex" }}><P.ComposerSpinner /></span> : null}
          model={plannedProps("runtime-picker-change")} modelLabel={card?.engine.modelSelection.model ?? "gpt-6.1-sol"} effort={plannedProps("runtime-picker-change")}
          send={sendButton} />
      </>}
    />
  );
}
