// GOAT 2 bot home. Matches the Paper SSOT 1:1 (docs/PAPER.md):
// static markup comes from ./ssotParts.tsx (generated from the Paper export); this file only adds
// the parts that move or respond: roster selection and folding, the runtime picker, worker-thread
// folds, and overview section folds. Style values below are copied from the same export.
import { useState, type CSSProperties, type ReactNode } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import { bots, catalog, initialRuntimes, type BotRow, type BotRuntime } from "./placeholder.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import {
  ApprovalCard, BotBody, BotBubble, ChatHeader, Composer, EvidenceCard, OverviewHeader,
  RosterFooter, RosterTop, RoutineEvent, ThreadsBody,
} from "./ssotParts.tsx";

const INTER = '"Inter", "Noto Sans KR", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const PANEL = "#F7F7F8";
const SELECTED = "#E9E9EC";
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const GLYPH_PX: Record<string, number> = { codex: 10, claudeAgent: 10, antigravity: 11, pi: 9, opencode: 9 };

function Chevron({ open, dir = "right" }: { open: boolean; dir?: "right" | "down" }) {
  const base = dir === "right" ? 0 : 90;
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"
      style={{ flexShrink: 0, transform: `rotate(${open ? base + 90 : base}deg)`, transition: `transform 200ms ${EASE}` }}>
      <path d="M9 6l6 6-6 6" fill="none" stroke="#3A3A3F" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function SectionChevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"
      style={{ transform: open ? "none" : "rotate(180deg)", transition: `transform 200ms ${EASE}` }}>
      <path d="M6 15l6-6 6 6" fill="none" stroke="#8A8A90" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** Avatar: body + needs-you dot (32,2) + knockout provider chip (28,28, 16px) + working ring (25,25, 22px). */
function Avatar({ bot, driver, surface }: { bot: BotRow; driver: string; surface: string }) {
  return (
    <div style={{ position: "relative", width: 44, height: 44, flexShrink: 0 }}>
      <div style={{ position: "absolute", left: 0, top: 0 }}><BotBody id={bot.id} /></div>
      {bot.status === "needs-you" && (
        <div aria-label="Needs you" style={{ position: "absolute", left: 32, top: 2, width: 10, height: 10, borderRadius: 9999, background: "#E5484D", boxShadow: `${surface} 0px 0px 0px 2px` }} />
      )}
      <div title={catalog.find((c) => c.driver === driver)?.label ?? driver}
        style={{ position: "absolute", left: 28, top: 28, width: 16, height: 16, borderRadius: 9999, background: surface, boxShadow: `${surface} 0px 0px 0px 2px`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <ProviderGlyph driver={driver} size={GLYPH_PX[driver] ?? 10} />
      </div>
      {bot.status === "working" && (
        <svg aria-label="Working" width="22" height="22" viewBox="0 0 28 28" style={{ position: "absolute", left: 25, top: 25, animation: "goat2-spin 1.2s linear infinite" }}>
          <circle cx="14" cy="14" r="12.6" fill="none" stroke="#DCDCE0" strokeWidth="1.6" />
          <circle cx="14" cy="14" r="12.6" transform="rotate(-90 14 14)" fill="none" stroke="#111113" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="24 56" />
        </svg>
      )}
    </div>
  );
}

const STATUS_COLOR = (b: BotRow) => (b.status === "needs-you" ? "#C8333A" : b.status === "working" ? "#5E5E64" : "#8A8A90");

function RosterRow({ bot, driver, selected, onSelect }: { bot: BotRow; driver: string; selected: boolean; onSelect: () => void }) {
  const surface = selected ? SELECTED : PANEL;
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      style={{ all: "unset", cursor: "pointer", alignItems: "center", backgroundColor: selected ? SELECTED : "transparent", borderRadius: 12, boxSizing: "border-box", display: "flex", gap: 12, padding: 10 }}>
      <Avatar bot={bot} driver={driver} surface={surface} />
      <div style={{ display: "flex", flexBasis: "0%", flexDirection: "column", flexGrow: 1, gap: 2, minWidth: 0 }}>
        <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
          <div style={{ color: "#111113", fontFamily: INTER, fontSize: 15, fontWeight: 700, lineHeight: "18px" }}>{bot.name}</div>
          <div style={{ color: STATUS_COLOR(bot), fontFamily: INTER, fontSize: 12, fontWeight: bot.status === "needs-you" ? 600 : 400, lineHeight: "16px" }}>{bot.when}</div>
        </div>
        <div style={{ color: "#5E5E64", fontFamily: INTER, fontSize: 13, lineHeight: "18px" }}>{bot.lastLine}</div>
      </div>
    </button>
  );
}

function Roster({ selectedId, onSelect, folded, onToggle, runtimes }: {
  selectedId: string; onSelect: (id: string) => void; folded: boolean; onToggle: () => void; runtimes: Record<string, BotRuntime>;
}) {
  const [main, ...rest] = bots;
  const col: CSSProperties = { backgroundColor: PANEL, borderRight: "1px solid #ECECEE", boxSizing: "border-box", display: "flex", flexDirection: "column", flexShrink: 0, gap: 16, height: "100%", padding: "16px 12px", width: folded ? 72 : 288, transition: `width 200ms ${EASE}`, overflow: "hidden" };
  if (folded) {
    return (
      <aside style={col}>
        <button type="button" onClick={onToggle} aria-label="Unfold roster" style={{ all: "unset", cursor: "pointer", alignSelf: "center", width: 36, height: 36, borderRadius: 10, border: "1px solid #E6E6E9", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="#3A3A3F" strokeWidth="2" /><path d="M9 4v16" fill="none" stroke="#3A3A3F" strokeWidth="2" /></svg>
        </button>
        {bots.map((b) => (
          <button key={b.id} type="button" onClick={() => onSelect(b.id)} aria-label={b.name}
            style={{ all: "unset", cursor: "pointer", alignSelf: "center", padding: 2, borderRadius: 12, background: b.id === selectedId ? SELECTED : "transparent" }}>
            <Avatar bot={b} driver={runtimes[b.id]!.driver} surface={b.id === selectedId ? SELECTED : PANEL} />
          </button>
        ))}
      </aside>
    );
  }
  return (
    <aside style={col}>
      <RosterTop onFold={onToggle} />
      <div style={{ borderBottom: "1px solid #ECECEE", display: "flex", flexDirection: "column", gap: 2, paddingBottom: 12 }}>
        {main && <RosterRow bot={main} driver={runtimes[main.id]!.driver} selected={selectedId === main.id} onSelect={() => onSelect(main.id)} />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rest.map((b) => <RosterRow key={b.id} bot={b} driver={runtimes[b.id]!.driver} selected={selectedId === b.id} onSelect={() => onSelect(b.id)} />)}
      </div>
      <RosterFooter />
    </aside>
  );
}

/** A worker thread in the transcript: one line folded (Paper "Run fold (collapsed)"), steps when open. */
function RunFold(props: { title: string; driver: string; model: string; right: ReactNode; steps: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const head: CSSProperties = { alignItems: "center", display: "flex", gap: 10, padding: "10px 14px", cursor: "pointer" };
  return (
    <div style={{ alignSelf: "flex-start", border: "1px solid #ECECEE", borderRadius: 12, boxSizing: "border-box", display: "flex", flexDirection: "column", width: 560 }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
        style={{ ...head, borderBottom: open ? "1px solid #F0F0F2" : "1px solid transparent" }}>
        <Chevron open={open} />
        <div style={{ color: "#111113", fontFamily: INTER, fontSize: 13, fontWeight: 500, lineHeight: "16px" }}>{props.title}</div>
        <div style={{ alignItems: "center", display: "flex", flexGrow: 1, gap: 6 }}>
          <ProviderGlyph driver={props.driver} size={12} />
          <div style={{ color: "#8A8A90", fontFamily: MONO, fontSize: 12, lineHeight: "16px" }}>{props.model}</div>
        </div>
        {props.right}
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px 12px 36px" }}>
          {props.steps.map((s) => <div key={s} style={{ color: "#3A3A3F", fontFamily: INTER, fontSize: 13, lineHeight: "16px" }}>{s}</div>)}
        </div>
      )}
    </div>
  );
}

function Chat({ bot, runtime, onRuntime }: { bot: BotRow; runtime: BotRuntime; onRuntime: (r: BotRuntime) => void }) {
  return (
    <main style={{ backgroundColor: "#FFFFFF", display: "flex", flexBasis: "0%", flexDirection: "column", flexGrow: 1, height: "100%", minWidth: 0 }}>
      <ChatHeader botId={bot.id} botName={bot.name} />
      <div style={{ display: "flex", flexShrink: 0, justifyContent: "center", paddingBottom: 8, paddingInline: 40 }}>
        <RuntimePicker value={runtime} onChange={onRuntime} placement="below" variant="bar" />
      </div>
      <div style={{ alignItems: "center", display: "flex", flexBasis: "0%", flexDirection: "column", flexGrow: 1, minHeight: 0, overflow: "auto", paddingInline: 40, paddingTop: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, width: 640, paddingBottom: 16 }}>
          <RoutineEvent />
          <BotBubble />
          <RunFold
            title="Worker thread · 23 steps" driver={runtime.driver} model={`${runtime.model} · 4:12`}
            right={<span style={{ color: "#3A3A3F", fontFamily: INTER, fontSize: 13, lineHeight: "16px", textDecoration: "underline 1px" }}>Open thread</span>}
            steps={["✓ Checked out codex/pr-7712 on Wicked", "✓ Ran 81 tests: 81 passed", "✓ Wrote 12 review comments"]}
          />
          <EvidenceCard />
          <RunFold
            title="Asked CI Watch to check" driver="claudeAgent" model="sonnet-5" defaultOpen
            right={<span style={{ color: "#5E5E64", fontFamily: INTER, fontSize: 12, lineHeight: "16px" }}>Done · 0:38</span>}
            steps={["✓ Rebuilt on latest main", "✓ Merge dry run: no conflicts", '✓ Reply: "No impact on main"']}
          />
          <ApprovalCard />
        </div>
      </div>
      <Composer botName={bot.name} picker={<RuntimePicker value={runtime} onChange={onRuntime} placement="above" variant="composer" />} />
    </main>
  );
}

function FoldRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid #F2F2F3", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}
        style={{ alignItems: "center", display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
        <div style={{ color: "#111113", fontFamily: INTER, fontSize: 13, fontWeight: 700, lineHeight: "16px" }}>
          {label} <span style={{ color: "#8A8A90", fontWeight: 400 }}>{hint}</span>
        </div>
        <SectionChevron open={open} />
      </div>
      {open && <div style={{ color: "#5E5E64", fontFamily: INTER, fontSize: 13, lineHeight: "18px" }}>{children}</div>}
    </div>
  );
}

function Overview({ bot, runtime, folded, onToggle }: { bot: BotRow; runtime: BotRuntime; folded: boolean; onToggle: () => void }) {
  const [runtimeOpen, setRuntimeOpen] = useState(true);
  const [threadsOpen, setThreadsOpen] = useState(true);
  if (folded) {
    return (
      <aside style={{ width: 56, flexShrink: 0, borderLeft: "1px solid #ECECEE", padding: "16px 12px", boxSizing: "border-box" }}>
        <button type="button" onClick={onToggle} aria-label="Unfold overview" style={{ all: "unset", cursor: "pointer", width: 32, height: 32, borderRadius: 8, border: "1px solid #ECECEE", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="#3A3A3F" strokeWidth="2" /><path d="M15 4v16" fill="none" stroke="#3A3A3F" strokeWidth="2" /></svg>
        </button>
      </aside>
    );
  }
  const cli = catalog.find((c) => c.driver === runtime.driver);
  const rows: Array<[string, string]> = [
    ["CLI", cli ? `${cli.label} ${cli.version}` : runtime.driver],
    ["Model", `${runtime.model} · ${runtime.effort}`],
    ["Machine", runtime.machine],
    ["Account", runtime.account],
    ["Access", runtime.permissions],
    ["Workspace", runtime.workspace],
  ];
  const header = (label: ReactNode, open: boolean, toggle: () => void) => (
    <div role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => e.key === "Enter" && toggle()}
      style={{ alignItems: "center", display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
      <div style={{ color: "#111113", fontFamily: INTER, fontSize: 13, fontWeight: 700, lineHeight: "16px" }}>{label}</div>
      <SectionChevron open={open} />
    </div>
  );
  return (
    <aside style={{ backgroundColor: "#FFFFFF", borderLeft: "1px solid #ECECEE", boxSizing: "border-box", display: "flex", flexDirection: "column", flexShrink: 0, gap: 20, height: "100%", overflow: "auto", padding: "16px 20px", width: 340 }}>
      <OverviewHeader botId={bot.id} botName={bot.name} onFold={onToggle} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {header("Runtime", runtimeOpen, () => setRuntimeOpen(!runtimeOpen))}
        {runtimeOpen && (
          <div style={{ border: "1px solid #ECECEE", borderRadius: 12, display: "flex", flexDirection: "column" }}>
            {rows.map(([k, v], i) => (
              <div key={k} style={{ borderBottom: i < rows.length - 1 ? "1px solid #F2F2F3" : "none", display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 12px" }}>
                <div style={{ color: "#5E5E64", fontFamily: INTER, fontSize: 13, lineHeight: "16px" }}>{k}</div>
                <div style={{ color: "#111113", fontFamily: MONO, fontSize: 12, fontWeight: k === "CLI" ? 500 : 400, lineHeight: "16px", textAlign: "right" }}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ paddingBottom: 4 }}>{header(<>Threads <span style={{ color: "#8A8A90", fontWeight: 400 }}>3</span></>, threadsOpen, () => setThreadsOpen(!threadsOpen))}</div>
        {threadsOpen && <ThreadsBody />}
      </div>
      <FoldRow label="Computer" hint="Wicked · asleep">The bot's machine is asleep. Opening it wakes Wicked and shows its screen here.</FoldRow>
      <FoldRow label="Routines" hint="On PR opened">On PR opened → review on Wicked with this bot's runtime.</FoldRow>
    </aside>
  );
}

export function BotHome() {
  const [selectedId, setSelectedId] = useState("reviewer");
  const [rosterFolded, setRosterFolded] = useState(false);
  const [overviewFolded, setOverviewFolded] = useState(false);
  const [runtimes, setRuntimes] = useState(initialRuntimes);
  const bot = bots.find((b) => b.id === selectedId) ?? bots[0]!;
  const runtime = runtimes[bot.id]!;
  const setRuntime = (r: BotRuntime) => setRuntimes((m) => ({ ...m, [bot.id]: r }));
  return (
    <div style={{ backgroundColor: "#FFFFFF", display: "flex", height: "100vh", minWidth: 1180, fontSynthesis: "none", WebkitFontSmoothing: "antialiased", overflow: "hidden" }}>
      <style>{"@keyframes goat2-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){[aria-label=Working]{animation:none!important}}"}</style>
      <Roster selectedId={selectedId} onSelect={setSelectedId} folded={rosterFolded} onToggle={() => setRosterFolded(!rosterFolded)} runtimes={runtimes} />
      <Chat bot={bot} runtime={runtime} onRuntime={setRuntime} />
      <Overview bot={bot} runtime={runtime} folded={overviewFolded} onToggle={() => setOverviewFolded(!overviewFolded)} />
    </div>
  );
}
