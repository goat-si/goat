// Worker thread in the right panel (25D-0): replaces the Overview; Go to thread opens it in thread mode.
import * as P from "../paper/parts.tsx";
import { useHost, useHostContext, useThread } from "../host/HostProvider.tsx";
import { duration } from "../lib/format.ts";
import { WorkFold } from "../threads/ThreadMode.tsx";

const btn = (label: string, onClick: () => void, extra: P.El = {}): P.El => ({
  role: "button", tabIndex: 0, "aria-label": label, title: label, onClick, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }, ...extra,
});

export function WorkerPanel({ threadId, onBack, onOpen }: { threadId: string; onBack: () => void; onOpen: () => void }) {
  const snap = useHost();
  const { now } = useHostContext();
  const card = snap.state.cards[threadId];
  const t = useThread(threadId);
  const nowIso = now().toISOString();
  const run = t.lastRun;
  const state = card?.status === "running" ? "Working" : card?.status === "failed" ? "Failed" : card?.status === "needs_you" ? "Needs you" : "Done";
  const took = card?.status === "running" && t.activeRunStartedAt ? duration(t.activeRunStartedAt, nowIso) : run ? duration(run.startedAt, run.finishedAt ?? nowIso) : null;
  const meta = [state, took, card?.engine.modelSelection.model].filter(Boolean).join(" · ");
  return (
    <P.ThreadPanel title={card?.title ?? ""} meta={meta} openTag={null}
      back={btn("Back to Overview", onBack)} open={btn("Go to thread", onOpen)} close={btn("Close thread", onBack)}
      body={<div data-worker-panel={threadId} style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflow: "auto" }}>
        {t.entries.map((e) => e.kind === "user" && e.source === "system" ? <P.RoutineLine key={e.key} text={e.text} />
          : e.kind === "user" ? <P.PanelUserBubble key={e.key} text={e.text} />
          : e.kind === "work" ? <div key={e.key}><WorkFold e={e} nowIso={nowIso} /></div>
          : e.kind === "bot" ? <P.PanelAnswer key={e.key} text={e.text} /> : null)}
      </div>} />
  );
}
