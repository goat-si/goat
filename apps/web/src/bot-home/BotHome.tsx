// GOAT 2 bot-first home: Roster | Chat | Overview. Layout follows the Paper SSOT
// (https://app.paper.design/file/01M8GDWPDQSBBWW8RMTG12PGCC). Versions are NOT shown in the
// roster; the roster carries only the provider chip. Runtime details live in the chat runtime bar
// and the Overview "Runtime" section.
import { useState, type CSSProperties, type ReactNode } from "react";
import { AvatarWithChip, ProviderGlyph } from "@goat2/provider-icons";
import { bots, selectedRuntime, type BotRow } from "./placeholder.ts";

const ink = "#111113";
const muted = "#5E5E64";
const faint = "#8A8A90";
const line = "#ECECEE";
const mono: CSSProperties = { fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12 };

function Face({ color }: { color: string }) {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18" fill={color} />
      <ellipse cx="15" cy="19" rx="2.8" ry="3.8" fill={color === "#111113" ? "#fff" : "#1A1A1A"} />
      <ellipse cx="25" cy="19" rx="2.8" ry="3.8" fill={color === "#111113" ? "#fff" : "#1A1A1A"} />
    </svg>
  );
}

function RosterRow({ bot, selected, onSelect }: { bot: BotRow; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: 10,
        borderRadius: 12,
        background: selected ? "#E9E9EC" : "transparent",
      }}
    >
      <AvatarWithChip driver={bot.driver} working={bot.status === "working"} needsYou={bot.status === "needs-you"} ringColor={selected ? "#E9E9EC" : "#F7F7F8"}>
        <Face color={bot.color} />
      </AvatarWithChip>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: 15, color: ink }}>{bot.name}</strong>
          <span style={{ fontSize: 12, fontWeight: bot.status === "needs-you" ? 600 : 400, color: bot.status === "needs-you" ? "#C8333A" : faint }}>{bot.when}</span>
        </span>
        <span style={{ fontSize: 13, lineHeight: "18px", color: muted }}>{bot.lastLine}</span>
      </span>
    </button>
  );
}

function Roster({ selectedId, onSelect, folded, onToggle }: { selectedId: string; onSelect: (id: string) => void; folded: boolean; onToggle: () => void }) {
  const [main, ...rest] = bots;
  return (
    <aside style={{ width: folded ? 64 : 288, flexShrink: 0, background: "#F7F7F8", borderRight: `1px solid ${line}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {!folded && <input placeholder="Search bots and threads" style={{ flex: 1, height: 36, border: 0, borderRadius: 10, background: "#EEEEF0", padding: "0 12px" }} />}
        <button type="button" onClick={onToggle} aria-label={folded ? "Expand roster" : "Collapse roster"} style={{ width: 36, height: 36, borderRadius: 10, border: `1px solid ${line}`, background: "#fff" }}>⇤</button>
      </div>
      {folded ? (
        bots.map((bot) => (
          <button key={bot.id} type="button" onClick={() => onSelect(bot.id)} style={{ all: "unset", cursor: "pointer" }}>
            <AvatarWithChip driver={bot.driver} working={bot.status === "working"} needsYou={bot.status === "needs-you"}>
              <Face color={bot.color} />
            </AvatarWithChip>
          </button>
        ))
      ) : (
        <>
          {main ? <RosterRow bot={main} selected={selectedId === main.id} onSelect={() => onSelect(main.id)} /> : null}
          <div style={{ borderTop: `1px solid ${line}` }} />
          {rest.map((bot) => (
            <RosterRow key={bot.id} bot={bot} selected={selectedId === bot.id} onSelect={() => onSelect(bot.id)} />
          ))}
          <div style={{ marginTop: "auto", borderTop: `1px solid ${line}`, paddingTop: 12, fontSize: 14, color: "#3A3A3F", display: "flex", flexDirection: "column", gap: 10 }}>
            <span>+ New bot</span>
            <span>Connect apps and machines</span>
          </div>
        </>
      )}
    </aside>
  );
}

function Fold({ title, meta, children, defaultOpen = false }: { title: string; meta: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1px solid ${line}`, borderRadius: 12 }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ all: "unset", cursor: "pointer", display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", width: "100%", boxSizing: "border-box" }}>
        <span>{open ? "▾" : "▸"}</span>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <span style={{ ...mono, color: faint, flex: 1 }}>{meta}</span>
        <span style={{ fontSize: 13, textDecoration: "underline" }}>Open thread</span>
      </button>
      {open ? <div style={{ padding: "4px 14px 12px 36px", fontSize: 13, color: "#3A3A3F" }}>{children}</div> : null}
    </div>
  );
}

function Chat({ bot }: { bot: BotRow }) {
  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <header style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 14px", border: `1px solid ${line}`, borderRadius: 9999 }}>
          <strong style={{ fontSize: 14 }}>{bot.name}</strong>
        </span>
      </header>
      {/* Runtime bar: chip + model only. Click expands to Overview → Runtime. */}
      <div style={{ display: "flex", justifyContent: "center", paddingBottom: 8 }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", borderRadius: 10, background: "#F7F7F8" }}>
          <ProviderGlyph driver={bot.driver} size={14} />
          <span style={{ ...mono, color: muted }}>{selectedRuntime.model}</span>
        </span>
      </div>
      <section style={{ flex: 1, overflow: "auto", display: "flex", justifyContent: "center", padding: "8px 40px" }}>
        <div style={{ width: 640, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ textAlign: "center", fontSize: 13, color: faint }}>Routine "Review on PR open" ran · 3:02 PM · PR #7712</div>
          <div style={{ alignSelf: "flex-start", maxWidth: 560, padding: "12px 16px", borderRadius: 18, background: "#F2F2F3", fontSize: 15, lineHeight: "24px" }}>
            Finished reviewing opencodex #7712. Tests pass. One concern: an account-list failure shows an empty list; keeping the last list looks safer.
          </div>
          <Fold title="Worker thread · 23 steps" meta="gpt-6.1-sol · 4:12">
            Steps load from the CLI's own session log when opened (not stored in GOAT's DB).
          </Fold>
          <div style={{ border: `1px solid ${line}`, borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <strong>Merge PR #7712 into main?</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={{ padding: "9px 16px", borderRadius: 10, background: ink, color: "#fff", border: 0 }}>Merge #7712</button>
              <button type="button" style={{ padding: "9px 16px", borderRadius: 10, background: "#fff", border: "1px solid #E0E0E4" }}>Fix first, then merge</button>
              <button type="button" style={{ padding: "9px 12px", border: 0, background: "transparent", color: muted }}>Hold</button>
            </div>
          </div>
        </div>
      </section>
      <footer style={{ display: "flex", justifyContent: "center", padding: "12px 40px 20px" }}>
        <div style={{ width: 640, display: "flex", gap: 10, alignItems: "center", padding: "8px 8px 8px 16px", borderRadius: 9999, border: "1px solid #E0E0E4" }}>
          <input placeholder={`Message ${bot.name}`} style={{ flex: 1, border: 0, outline: 0, fontSize: 15 }} />
          <span style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 10px", borderRadius: 9999, background: "#F2F2F3" }}>
            <ProviderGlyph driver={bot.driver} size={12} />
            <span style={{ ...mono }}>gpt-6.1-sol</span>
          </span>
        </div>
      </footer>
    </main>
  );
}

function Overview({ bot, folded, onToggle }: { bot: BotRow; folded: boolean; onToggle: () => void }) {
  if (folded) {
    return (
      <aside style={{ width: 48, borderLeft: `1px solid ${line}`, padding: 8 }}>
        <button type="button" onClick={onToggle} aria-label="Open overview">⇥</button>
      </aside>
    );
  }
  const rows: Array<[string, string]> = [
    ["CLI", selectedRuntime.cli],
    ["Model", selectedRuntime.model],
    ["Machine", selectedRuntime.machine],
    ["Account", selectedRuntime.account],
    ["Permissions", selectedRuntime.permissions],
    ["Workspace", selectedRuntime.workspace],
  ];
  return (
    <aside style={{ width: 340, flexShrink: 0, borderLeft: `1px solid ${line}`, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 16 }}>{bot.name}</strong>
        <button type="button" onClick={onToggle} aria-label="Collapse overview">⇥</button>
      </div>
      <section>
        <strong style={{ fontSize: 13 }}>Runtime</strong>
        <div style={{ marginTop: 10, border: `1px solid ${line}`, borderRadius: 12 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "9px 12px", borderBottom: `1px solid #F2F2F3` }}>
              <span style={{ fontSize: 13, color: muted }}>{k}</span>
              <span style={{ ...mono, color: ink }}>{v}</span>
            </div>
          ))}
        </div>
      </section>
      <section style={{ fontSize: 13 }}>
        <strong>Worker threads</strong> <span style={{ color: faint }}>3</span>
      </section>
    </aside>
  );
}

export function BotHome() {
  const [selectedId, setSelectedId] = useState("reviewer");
  const [rosterFolded, setRosterFolded] = useState(false);
  const [overviewFolded, setOverviewFolded] = useState(false);
  const bot = bots.find((b) => b.id === selectedId) ?? bots[0]!;
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Inter, 'Noto Sans KR', system-ui, sans-serif", color: ink, background: "#fff" }}>
      <Roster selectedId={selectedId} onSelect={setSelectedId} folded={rosterFolded} onToggle={() => setRosterFolded(!rosterFolded)} />
      <Chat bot={bot} />
      <Overview bot={bot} folded={overviewFolded} onToggle={() => setOverviewFolded(!overviewFolded)} />
    </div>
  );
}
