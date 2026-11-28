// GOAT 2 bot home. Matches the Paper SSOT 1:1 (docs/PAPER.md):
// static markup comes from ./ssotParts.tsx (generated from the Paper export); this file only adds
// the parts that move or respond: roster selection and folding, the model picker (composer only),
// overview section folds, and opening a thread in the right panel. The chat shows messages and
// decisions only; threads open in the right panel (Paper state board "봇 홈 — 스레드 열림"). Style values below are copied from the same export.
import { useState, type CSSProperties, type ReactNode } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import { bots, catalog, initialRuntimes, type BotRow, type BotRuntime } from "./placeholder.ts";
import { RuntimePicker } from "./RuntimePicker.tsx";
import {
  ApprovalCard, BotBody, BotBubble, ChatHeader, Composer, OverviewHeader,
  RosterFooter, RosterTop, RoutineEvent, ThreadPanel, ThreadsBody,
} from "./ssotParts.tsx";

const INTER = '"Inter", "Noto Sans KR", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const PANEL = "#F7F7F8";
const SELECTED = "#E9E9EC";
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const GLYPH_PX: Record<string, number> = { codex: 10, claudeAgent: 10, antigravity: 11, pi: 9, opencode: 9 };

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

function Chat({ bot, runtime, onRuntime }: { bot: BotRow; runtime: BotRuntime; onRuntime: (r: BotRuntime) => void }) {
  return (
    <main style={{ backgroundColor: "#FFFFFF", display: "flex", flexBasis: "0%", flexDirection: "column", flexGrow: 1, height: "100%", minWidth: 0 }}>
      <ChatHeader botId={bot.id} botName={bot.name} />
      {/* One model picker only: the composer chip (Paper SSOT, 2026-11-28). */}
      <div style={{ alignItems: "center", display: "flex", flexBasis: "0%", flexDirection: "column", flexGrow: 1, minHeight: 0, overflow: "auto", paddingInline: 40, paddingTop: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, width: 640, paddingBottom: 16 }}>
          <RoutineEvent />
          <BotBubble />
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

function Overview({ bot, runtime, folded, onToggle, onOpenThread }: { bot: BotRow; runtime: BotRuntime; folded: boolean; onToggle: () => void; onOpenThread: (id: string) => void }) {
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
        {threadsOpen && <ThreadsBody onOpen={onOpenThread} />}
      </div>
      <FoldRow label="Computer" hint="Wicked · asleep">The bot's machine is asleep. Opening it wakes Wicked and shows its screen here.</FoldRow>
      <FoldRow label="Routines" hint="On PR opened">On PR opened → review on Wicked with this bot's runtime.</FoldRow>
    </aside>
  );
}

export function BotHome() {
  const [selectedId, setSelectedIdRaw] = useState("reviewer");
  const setSelectedId = (id: string) => { setSelectedIdRaw(id); setOpenThread(null); };
  const [rosterFolded, setRosterFolded] = useState(false);
  const [overviewFolded, setOverviewFolded] = useState(false);
  const [runtimes, setRuntimes] = useState(initialRuntimes);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const bot = bots.find((b) => b.id === selectedId) ?? bots[0]!;
  const runtime = runtimes[bot.id]!;
  const setRuntime = (r: BotRuntime) => setRuntimes((m) => ({ ...m, [bot.id]: r }));
  return (
    <div style={{ backgroundColor: "#FFFFFF", display: "flex", height: "100vh", minWidth: 1180, fontSynthesis: "none", WebkitFontSmoothing: "antialiased", overflow: "hidden" }}>
      <style>{"@keyframes goat2-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){[aria-label=Working]{animation:none!important}}"}</style>
      <Roster selectedId={selectedId} onSelect={setSelectedId} folded={rosterFolded} onToggle={() => setRosterFolded(!rosterFolded)} runtimes={runtimes} />
      <Chat bot={bot} runtime={runtime} onRuntime={setRuntime} />
      {openThread && !overviewFolded ? (
        <ThreadPanel onBack={() => setOpenThread(null)} onClose={() => setOpenThread(null)} onShowAll={() => {}} />
      ) : (
        <Overview bot={bot} runtime={runtime} folded={overviewFolded} onToggle={() => setOverviewFolded(!overviewFolded)} onOpenThread={setOpenThread} />
      )}
    </div>
  );
}
