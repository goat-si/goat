// GOAT 2 web UI. Layout and every visual value come from the Paper boards through generated parts
// (src/paper/parts.tsx, scripts/paper-parts.py); this file only wires data and interaction.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import * as P from "./paper/parts.tsx";
import { useClient, useHost, useHostContext, useThread } from "./host/HostProvider.tsx";
import { botRows, workerThreads, type BotRowData } from "./host/store.ts";
import type { CommandResult, RequestOpened, RequestOutcome, TurnItem } from "./host/wire.ts";
import { Planned, plannedProps } from "./planned/Planned.tsx";
import { useUi, type UiStore } from "./ui-state/uiState.ts";
import { clock, duration, shortTime } from "./lib/format.ts";
import { Face } from "./bot-home/Face.tsx";
import { BotFace, FaceGallery, faceFromId } from "@goat2/bot-face";
import { NewBotDialog } from "./bot-home/NewBot.tsx";
import { ThreadMode } from "./threads/ThreadMode.tsx";
import { WorkerPanel } from "./bot-home/WorkerPanel.tsx";
import { SETTINGS_GOAT_BOT_PATH, SETTINGS_PROVIDERS_PATH } from "./settings/SettingsMode.tsx";
import { installProviderPort, setV1Navigator } from "@v1/surfaces";
import { DEFAULT_SELECTION, ModelChip, useThreadModelChange } from "./providers/ModelChip.tsx";
import { hostProviderPort, type HostProviderPort } from "./providers/hostProviderPort.ts";
import { ProvidersProvider } from "./providers/context.tsx";
import { ProvidersMode } from "./providers/ProvidersMode.tsx";
import { setProvidersOpener } from "./providers/navigation.ts";
import { BotSettingsMain } from "./providers/BotSettings.tsx";

const btn = (label: string, onClick: () => void, extra: P.El = {}): P.El => ({
  role: "button", tabIndex: 0, "aria-label": label, onClick, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }, ...extra,
});

function sortBots(rows: BotRowData[]) {
  const rank = (r: BotRowData) => (r.role === "main" ? 0 : r.state === "working" ? 1 : 2);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

export function App({ ui: store, scene }: { ui: UiStore; scene: string | null }) {
  if (scene === "2D0-1") return <div style={{ height: "100%", overflow: "auto" }}><FaceGallery /></div>;
  return <WithProviders><Workspace ui={store} scene={scene} /></WithProviders>;
}

/** One provider port per host client: the GOAT 2 provider screens read it from context, the lifted v1 seam from
 * installProviderPort (docs/part2/provider-wire.md). */
function WithProviders({ children }: { children: ReactNode }) {
  const client = useClient();
  const [port, setPort] = useState<HostProviderPort | null>(null);
  useEffect(() => {
    const p = hostProviderPort(client);
    installProviderPort(p);
    setPort(p);
    return () => { installProviderPort(null); setPort(null); p.dispose(); };
  }, [client]);
  return <ProvidersProvider port={port}>{children}</ProvidersProvider>;
}

function Workspace({ ui: store, scene }: { ui: UiStore; scene: string | null }) {
  const [ui, setUi] = useUi(store);
  const snap = useHost();
  const client = useClient();
  const { desktop, build } = useHostContext();
  // The model picker's "Open Providers" and "+" (providers/navigation.ts).
  useEffect(() => {
    setProvidersOpener((target) => setUi({ mode: "settings", settingsPath: SETTINGS_PROVIDERS_PATH,
      settingsSearch: target.view ? { view: target.view } : target.instanceId ? { instanceId: target.instanceId } : {} }));
    return () => setProvidersOpener(null);
  }, [setUi]);
  // Where lifted v1 code navigates (v1 useNavigate / Link): settings paths open Settings, v1's thread route
  // "/<environmentId>/<threadId>" opens the thread in thread mode.
  useEffect(() => {
    setV1Navigator((to) => {
      if (to.pathname.startsWith("/settings")) {
        setUi({ mode: "settings", settingsPath: to.pathname, settingsSearch: to.search as Record<string, string> });
        return;
      }
      const thread = /^\/[^/]+\/([^/]+)$/.exec(to.pathname);
      if (thread) setUi({ mode: "threads", threadId: decodeURIComponent(thread[1]!) });
    });
  }, [setUi]);
  const rows = useMemo(() => botRows(snap.state), [snap.state]);
  const main = rows.find((r) => r.role === "main") ?? null;
  const bot = rows.find((r) => r.botId === ui.botId) ?? main;
  /** The bot whose settings page is open (?botId=, else the main bot). */
  const settingsBot = rows.find((r) => r.botId === ui.settingsSearch?.botId) ?? main;
  const needsCount = rows.filter((r) => r.state === "needs-you").length;
  const [railSearch, setRailSearch] = useState(false);
  const [newBot, setNewBot] = useState(scene === "2PU-1");

  const toggleSidebar = () => setUi((s) => ({ sidebarOpen: !s.sidebarOpen }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lights = desktop ? <div data-no-drag="" style={{ width: 52, height: 12, flexShrink: 0 }} /> : <P.TrafficLights />;
  const navProps = {
    toggle: btn("Toggle main sidebar (⌘B)", toggleSidebar, { title: "Toggle main sidebar (⌘B)" }),
    back: btn("Back", () => history.back()),
    forward: btn("Forward", () => history.forward()),
  };
  const topLeft = ui.sidebarOpen
    ? <P.TopLeft lights={lights} nav={<P.NavButtons {...navProps} />} bell={<P.Bell button={plannedProps("notifications")} count={null} />} />
    : <P.TopLeftCollapsed lights={lights} nav={<P.NavButtonsCollapsed {...navProps} />} />;
  const stamp = build ? (
    <span data-build-stamp="" title={`${build.branch} · built ${build.builtAt}`} style={{ color: "#8F8F8F", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 11, lineHeight: "16px", marginRight: 8, whiteSpace: "nowrap" }}>
      {build.commit.slice(0, 7)}{build.dirty ? "+" : ""} · {build.branch}
    </span>
  ) : snap.demo ? (
    <span data-demo-tag="" title="No GOAT host is connected: this prototype runs a demo host in the page." style={{ color: "#8F8F8F", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 11, lineHeight: "16px", marginRight: 8, padding: "0 6px", borderRadius: 4, background: "#F3F3F3" }}>{import.meta.env.VITE_GOAT2_COMMIT ? `Demo · ${import.meta.env.VITE_GOAT2_COMMIT}` : "Demo"}</span>
  ) : null;
  const topRight = (
    <P.TopRight>
      {ui.mode === "settings"
        ? ui.settingsPath === SETTINGS_GOAT_BOT_PATH
          ? (settingsBot ? <P.TopTitle face={<Face bot={settingsBot} size={20} />} name={settingsBot.name} button={{}} /> : <span />)
          : (main ? <P.TopTitle face={<Face bot={main} size={20} />} name="Providers" button={{}} /> : <span />)
        : bot ? <P.TopTitle face={<Face bot={bot} size={20} />} name={bot.name} button={{}} /> : <span />}
      <P.TopActions split={plannedProps("multiplexer")} share={plannedProps("share")} stamp={stamp}
        panel={btn("Toggle right panel", () => setUi((s) => ({ panelOpen: !s.panelOpen })), { "aria-pressed": ui.panelOpen, "data-active": ui.panelOpen })} />
    </P.TopRight>
  );

  const railExtra = ui.railBots.map((id) => rows.find((r) => r.botId === id)).filter((r): r is BotRowData => !!r && r.role !== "main").map((r) => (
    <P.RailMainBot key={r.botId} face={<Face bot={r} size={17} />} badge={r.state === "needs-you" ? <P.RailBadge count={1} /> : null}
      button={btn(r.name, () => setUi({ mode: "bots", botId: r.botId, panelThreadId: null }), { "data-active": ui.mode === "bots" && ui.botId === r.botId, title: r.name })} />
  ));
  const rail = (
    <P.Rail
      main={main ? <P.RailMainBot face={<Face bot={main} size={17} />} badge={needsCount > 0 ? <P.RailBadge count={needsCount} /> : null}
        button={btn(main.name, () => setUi({ mode: "bots", botId: main.botId, panelThreadId: null }), { "data-active": ui.mode === "bots" && ui.botId === main.botId, title: main.name })} /> : null}
      extra={railExtra}
      home={<P.RailHome button={btn("Threads", () => setUi({ mode: "threads" }), { "data-active": ui.mode === "threads", title: "Threads" })} />}
      more={<div style={{ position: "relative" }}>
        <P.RailMore button={btn("Add a bot to the rail", () => setRailSearch((v) => !v), { "data-active": railSearch, title: "Add a bot to the rail" })} />
        {railSearch && <RailSearchPopover rows={rows} railBots={ui.railBots} onAdd={(id) => setUi((s) => ({ railBots: s.railBots.includes(id) ? s.railBots : [...s.railBots, id] }))} onClose={() => setRailSearch(false)} />}
      </div>}
      nav={<>
        <P.RailActivity button={plannedProps("activity")} />
        <P.RailInbox button={plannedProps("inbox")} />
        <P.RailUsage button={plannedProps("usage")} />
        <P.RailPulls button={plannedProps("pull-requests")} />
        <P.RailMemory button={plannedProps("library-memory")} />
        <P.RailRoutines button={plannedProps("routines")} />
        <P.RailMachines button={plannedProps("machines")} />
      </>}
      bottom={<><P.RailSearch button={plannedProps("search")} /><P.RailSettings button={btn("Settings", () => setUi({ mode: "settings" }), { "data-active": ui.mode === "settings", title: "Settings" })} /></>}
    />
  );

  const sidebar = ui.sidebarOpen ? <BotSidebar rows={rows} ui={ui} setUi={setUi} onNewBot={() => setNewBot(true)} /> : null;
  const mainArea = bot
    ? <P.Main chat={<BotChat bot={bot} onOpenTask={(id) => setUi({ panelThreadId: id, panelOpen: true })} />} panel={!ui.panelOpen ? null : ui.panelThreadId ? <WorkerPanel threadId={ui.panelThreadId} onBack={() => setUi({ panelThreadId: null })} onOpen={() => setUi((s) => ({ mode: "threads", threadId: s.panelThreadId, panelThreadId: null }))} /> : <Overview bot={bot} scene={scene} onOpenTask={(id) => setUi({ panelThreadId: id })} onEdit={() => setUi({ mode: "settings", settingsPath: SETTINGS_GOAT_BOT_PATH, settingsSearch: { botId: bot.botId } })} />} />
    : <P.Main chat={<Disconnected />} panel={null} />;
  if (ui.mode === "threads") {
    return (
      <div data-desktop={desktop ? "" : undefined} style={{ height: "100%" }}>
        <ThreadMode ui={ui} setUi={setUi} rail={rail} lights={desktop ? null : <P.ThreadTrafficLights />} stamp={stamp} toggleSidebar={toggleSidebar} />
      </div>
    );
  }
  if (ui.mode === "settings") {
    const top = <P.TopBar>{topLeft}{topRight}</P.TopBar>;
    return (
      <div data-desktop={desktop ? "" : undefined} style={{ height: "100%" }}>
        {ui.settingsPath === SETTINGS_GOAT_BOT_PATH
          ? <P.Frame top={top} rail={rail} sidebar={sidebar} main={<BotSettingsPage bot={settingsBot} />} />
          : <ProvidersMode ui={ui} setUi={setUi} top={top} rail={rail} />}
      </div>
    );
  }
  return (
    <div data-desktop={desktop ? "" : undefined} style={{ height: "100%" }}>
      <P.Frame top={<P.TopBar>{topLeft}{topRight}</P.TopBar>} rail={rail} sidebar={sidebar} main={mainArea} />
      {newBot && <NewBotDialog onClose={() => setNewBot(false)} onCreated={(botId) => { setNewBot(false); setUi({ mode: "bots", botId, panelThreadId: null }); }}
        initial={scene === "2PU-1" ? { name: "Reviewer", purpose: "Reviews every PR before merge and asks me when unsure.", face: { shape: "squircle", color: "goat", goat: true } } : undefined} />}
    </div>
  );
}

function Disconnected() {
  const snap = useHost();
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#5D5D5D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 13 }}>
      {snap.connection === "open" ? "Loading bots…" : "Not connected to GOAT host. Messages you send wait here until it connects."}
    </div>
  );
}

// ---------------------------------------------------------------- sidebar

function BotSidebar({ rows, ui, setUi, onNewBot }: { rows: BotRowData[]; ui: ReturnType<typeof useUi>[0]; setUi: ReturnType<typeof useUi>[1]; onNewBot: () => void }) {
  const pinned = ui.pinned.map((id) => rows.find((r) => r.botId === id)).filter((r): r is BotRowData => !!r);
  const rest = sortBots(rows.filter((r) => !ui.pinned.includes(r.botId)));
  const needs = rest.filter((r) => r.state === "needs-you");
  const others = rest.filter((r) => r.state !== "needs-you");
  const [needsOpen, setNeedsOpen] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const { now } = useHostContext();
  const select = (id: string) => setUi({ mode: "bots", botId: id, panelThreadId: null });
  const drag = (id: string): P.El => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData("text/x-goat2-bot", id); e.dataTransfer.effectAllowed = "move"; setDragging(id); },
    onDragEnd: () => setDragging(null),
  } as P.El);
  const dropOnTiles = (index?: number): P.El => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes("text/x-goat2-bot")) e.preventDefault(); },
    onDrop: (e) => {
      const id = e.dataTransfer.getData("text/x-goat2-bot");
      if (!id) return;
      e.preventDefault(); e.stopPropagation();
      setUi((s) => { const rest = s.pinned.filter((x) => x !== id); const at = index === undefined ? rest.length : Math.min(index, rest.length); return { pinned: [...rest.slice(0, at), id, ...rest.slice(at)] }; });
      setDragging(null);
    },
  });
  const dropOnList: P.El = {
    onDragOver: (e) => { if (dragging && ui.pinned.includes(dragging)) e.preventDefault(); },
    onDrop: (e) => { const id = e.dataTransfer.getData("text/x-goat2-bot"); if (id && ui.pinned.includes(id)) { e.preventDefault(); setUi((s) => ({ pinned: s.pinned.filter((x) => x !== id) })); } setDragging(null); },
  };
  const row = (r: BotRowData) => {
    const selected = ui.mode === "bots" && ui.botId === r.botId;
    const root = { ...btn(r.name, () => select(r.botId), { "data-selected": selected, "data-bot-row": r.botId }), ...drag(r.botId) };
    const face = <Face bot={r} size={32} />;
    if (r.state === "needs-you") {
      return selected
        ? <P.BotRowNeedsSelected key={r.botId} face={face} dot={<P.RowDotSelected />} name={r.name} line={r.line} root={root} />
        : <P.BotRowNeeds key={r.botId} face={face} dot={<P.RowDot />} name={r.name} line={r.line} root={root} />;
    }
    return <P.BotRow key={r.botId} face={face} name={r.name} line={r.line} time={shortTime(r.updatedAt, now())} root={root} />;
  };
  const showTiles = pinned.length > 0 || dragging !== null;
  return (
    <P.Sidebar>
      <P.SidebarSearch search={plannedProps("search")} compose={btn("New bot", onNewBot, { title: "New bot" })} />
      {showTiles && (pinned.length > 0 ? (
        <P.PinnedGrid root={{ ...dropOnTiles(), "data-pinned-grid": "" }}>
          {pinned.map((r, i) => (
            <P.PinnedTile key={r.botId} face={<Face bot={r} size={32} />} dot={r.state === "needs-you" ? <P.TileDot /> : null} name={r.name}
              root={{ ...btn(r.name, () => select(r.botId), { "data-selected": ui.mode === "bots" && ui.botId === r.botId, "data-tile": r.botId,
                onContextMenu: (e) => { e.preventDefault(); setUi((s) => ({ pinned: s.pinned.filter((x) => x !== r.botId) })); } }), ...drag(r.botId), ...dropOnTiles(i) }} />
          ))}
        </P.PinnedGrid>
      ) : (
        <div {...(dropOnTiles() as object)} data-pin-slot="" style={{ margin: "2px 0 8px", height: 44, borderRadius: 12, background: "#EDEDED", color: "#8F8F8F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 12 }}>Drag here to pin</div>
      ))}
      <div {...(dropOnList as object)} style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto", flex: 1 }}>
        {needs.length > 0 && <P.SectionHeaderCount label="Needs you" count={needs.length} root={btn(needsOpen ? "Collapse Needs you" : "Expand Needs you", () => setNeedsOpen((v) => !v), { "aria-expanded": needsOpen })} />}
        {needsOpen && needs.map(row)}
        {others.length > 0 && <P.SectionHeader label="Bots" />}
        {others.map(row)}
      </div>
    </P.Sidebar>
  );
}

function RailSearchPopover({ rows, railBots, onAdd, onClose }: { rows: BotRowData[]; railBots: string[]; onAdd: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const list = rows.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  // Values from 1KL4-1 (rail "…" → search popover).
  return (
    <div ref={ref} role="dialog" aria-label="Add a bot to the rail" data-rail-search="" style={{ position: "absolute", left: 36, top: -64, zIndex: 20, width: 280, background: "#FFFFFF", borderRadius: 12, boxShadow: "#ECECEC 0px 0px 0px 1px, #0000001A 0px 8px 24px", padding: 8, boxSizing: "border-box", fontFamily: '"SF Pro", system-ui, sans-serif' }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 34, borderRadius: 8, background: "#F3F3F3", paddingInline: 10 }}>
        <svg width="14" height="14" viewBox="0 0 24 24"><circle cx="11.5" cy="11.5" r="9.5" fill="none" stroke="#5D5D5D" strokeWidth="1.75" strokeLinecap="round" /><path d="M18.217 18.218L22 22" fill="none" stroke="#5D5D5D" strokeWidth="1.75" strokeLinecap="round" /></svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search bots" style={{ all: "unset", flex: 1, fontSize: 14, lineHeight: "20px", color: "#0D0D0D" }} />
      </div>
      <div style={{ color: "#8F8F8F", fontSize: 12, lineHeight: "16px", padding: "10px 10px 6px" }}>Add to rail</div>
      {list.map((r) => {
        const onRail = r.role === "main" || railBots.includes(r.botId);
        return (
          <div key={r.botId} {...btn(onRail ? `${r.name} is on the rail` : `Add ${r.name} to the rail`, () => { if (!onRail) onAdd(r.botId); })} data-rail-option={r.botId}
            style={{ display: "flex", alignItems: "center", gap: 10, height: 44, borderRadius: 8, paddingInline: 8, background: "transparent" }}
            onPointerEnter={(e) => { e.currentTarget.style.background = "#F3F3F3"; }} onPointerLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            <Face bot={r} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, lineHeight: "16px", color: "#0D0D0D" }}>{r.name}</div>
              <div style={{ fontSize: 12, lineHeight: "16px", color: "#8F8F8F", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.role === "main" ? "Main bot · always on the rail" : r.line}</div>
            </div>
            {onRail
              ? <svg width="14" height="14" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" fill="none" stroke="#0D0D0D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="#5D5D5D" strokeWidth="2" strokeLinecap="round" /></svg>}
          </div>
        );
      })}
      <div style={{ borderTop: "1px solid #ECECEC", margin: "6px 2px 0", padding: "10px 8px 4px", color: "#8F8F8F", fontSize: 12, lineHeight: "16px" }}>Only the main bot is on the rail by default.</div>
    </div>
  );
}

// ---------------------------------------------------------------- chat

/** Settings > GOAT Bot: the bot's model (board 1QYE-2), the same picker and change_thread as the composer. */
function BotSettingsPage({ bot }: { bot: BotRowData | null }) {
  const { change, error } = useThreadModelChange(bot?.threadId ?? null);
  if (!bot) return <div style={{ padding: 32, color: "#5D5D5D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 13 }}>Loading bots…</div>;
  return <BotSettingsMain name={bot.name} purpose={bot.purpose || null} selection={bot.card?.engine.modelSelection ?? DEFAULT_SELECTION} onChange={change} error={error} />;
}

function BotModelPicker({ bot }: { bot: BotRowData }) {
  const { change, error } = useThreadModelChange(bot.threadId);
  return <ModelChip selection={bot.card?.engine.modelSelection ?? DEFAULT_SELECTION} onChange={change} label={bot.name} error={error} />;
}

function BotChat({ bot, onOpenTask }: { bot: BotRowData; onOpenTask: (id: string) => void }) {
  const client = useClient();
  const snap = useHost();
  const thread = useThread(bot.threadId);
  const [draft, setDraft] = useState("");
  const outbox = snap.outbox.filter((e) => e.target.botId === bot.botId || (bot.threadId !== null && e.target.threadId === bot.threadId));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    client.sendMessage(bot.threadId ? { threadId: bot.threadId, botId: bot.botId } : { botId: bot.botId }, text, bot.card?.followUpMode === "steer" ? "steer" : "followup");
    setDraft("");
  };
  const items: ReactNode[] = [];
  for (const e of thread.entries) {
    if (e.kind === "user" && e.source === "system") items.push(<P.RoutineLine key={e.key} text={`${e.text} · ${clock(e.at)}`} />);
    else if (e.kind === "user") items.push(<UserBubble key={e.key} text={e.text} />);
    else if (e.kind === "bot") items.push(<P.BotMessage key={e.key} text={e.text} />);
    else if (e.kind === "child") {
      const worked = e.reported ? ` · worked for ${duration(e.at, e.reported.at)}` : " · working";
      items.push(<P.ChildRow key={e.key} text={`${e.task}${worked}`} root={btn(e.task, () => onOpenTask(e.childThreadId), { "data-child-row": e.childThreadId })} />);
    }
  }
  for (const r of thread.openRequests) if (!hidden.has(r.requestId)) items.push(<RequestCard key={r.requestId} threadId={bot.threadId!} request={r} item={thread.requestItems[r.requestId]} onLoadDetails={thread.hasOlder ? () => client.readOlder(bot.threadId!) : undefined} onHide={() => setHidden((s) => new Set(s).add(r.requestId))} />);
  for (const o of outbox) {
    const status = o.status === "unconfirmed" ? "Not confirmed" : o.status === "failed" ? `Not sent · ${o.error ?? ""}` : snap.connection === "open" ? "Sent" : `Sent · ${bot.name} starts when the host connects`;
    items.push(
      <P.SentMessage key={o.clientRequestId} text={o.text} status={status}
        face={o.status === "unconfirmed" || o.status === "failed" ? null : <BotFace face={bot.face ?? faceFromId(bot.botId)} size={12} mood="work" tier="live" />}
        actions={o.status === "unconfirmed" || o.status === "failed" ? <>
          <TextButton label="Resend" onClick={() => client.resend(o.clientRequestId)} />
          <TextButton label="Delete" onClick={() => client.discard(o.clientRequestId)} />
        </> : null} />,
    );
  }
  return (
    <P.ChatColumn
      transcript={<P.Transcript root={{ "data-transcript": "" }}>{items}</P.Transcript>}
      composer={<P.Composer
        input={<textarea className="goat2-input" rows={1} value={draft} placeholder={`Message ${bot.name}`} aria-label={`Message ${bot.name}`}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          style={{ color: "#0D0D0D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 14, lineHeight: "20px" }} />}
        plus={plannedProps("attachments")}
        send={btn("Send", send, { "aria-disabled": draft.trim() === "", "data-send": "" })}
        picker={<BotModelPicker bot={bot} />} />}
    />
  );
}

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <span {...(btn(label, onClick) as object)} style={{ color: "#0D0D0D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 12, lineHeight: "16px", textDecoration: "underline", textUnderlineOffset: 2 }}>{label}</span>;
}

function UserBubble({ text }: { text: string }) {
  return <P.SentMessage text={text} face={null} status={null} actions={null} />;
}

export function RequestCard({ threadId, request, item, onHide, onLoadDetails }: { threadId: string; request: RequestOpened; item?: TurnItem | undefined; onHide: () => void; onLoadDetails?: (() => void) | undefined }) {
  const client = useClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [title, ...rest] = request.summary.split("\n");
  const inFlight = useRef(false);
  const resolve = async (key: string, body: { outcome: RequestOutcome; optionId?: string; text?: string; answers?: Record<string, string | string[]> }) => {
    // One answer at a time: conflicting outcomes cannot be sent while the first is pending.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(key); setError(null);
    const r: CommandResult = await client.command({ type: "resolve_request", threadId, requestId: request.requestId, ...body });
    inFlight.current = false;
    setPending(null);
    if (!r.ok) setError(r.error?.message ?? "The host did not take this answer.");
  };
  const action = (key: string, label: string, primary: boolean, body: Parameters<typeof resolve>[1], hint?: string, disabledIn = false) => {
    const disabled = disabledIn || pending !== null;
    const props = disabled ? { role: "button", "aria-disabled": true, "aria-label": label, title: hint ?? label, "data-option": key } as P.El
      : btn(label, () => void resolve(key, body), { "aria-busy": pending === key, title: hint ?? label, "data-option": key });
    return primary ? <P.DecisionPrimary key={key} label={label} button={props} /> : <P.DecisionSecondary key={key} label={label} button={props} />;
  };
  const notNow = <P.DecisionSecondary key="later" label="Not now" button={btn("Not now (hides it here; it still waits)", onHide)} />;
  const text = (t: ReactNode) => <div style={{ color: "#5D5D5D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 13, lineHeight: "18px" }}>{t}</div>;
  let buttons: ReactNode[];
  let body: ReactNode = rest.join(" ") || null;
  if (request.kind === "decision" && (request.options?.length ?? 0) > 0) {
    buttons = request.options!.map((o, i) => action(o.id, o.label, o.id === (request.recommended ?? request.options![0]!.id) || (request.recommended === undefined && i === 0), { outcome: "decided", optionId: o.id }, o.consequence));
  } else if (request.kind === "approval" && item?.type === "approval_request") {
    // v1 CodexAdapterV2: the waiting item carries the prompt, the reason and the offered decisions.
    body = <>{item.prompt && text(<code style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 12 }}>{item.prompt}</code>)}{item.reason && text(item.reason)}{!item.prompt && !item.reason && body}</>;
    const offered = item.options?.length ? item.options : [{ decision: "accept" as const, label: "Approve" }, { decision: "decline" as const, label: "Decline" }];
    buttons = offered.map((o, i) => action(o.decision, o.label, i === 0, { outcome: o.decision }, o.warning));
  } else if (request.kind === "question" && item?.type === "user_input_request") {
    // The text box shows custom ?? initialAnswer; the same value is validated and sent, unchanged.
    // v1: custom text is allowed unless allowCustomAnswer is false. Only a visible box counts.
    const canType = (q: (typeof item.questions)[number]) => q.allowCustomAnswer !== false;
    const typedOf = (q: (typeof item.questions)[number]) => (canType(q) ? custom[q.id] ?? q.initialAnswer ?? "" : "");
    const missing = item.questions.filter((q) => q.required !== false && !(answers[q.id]?.length) && typedOf(q).trim() === "");
    body = <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {item.questions.map((q) => (
        <div key={q.id} data-question={q.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {text(<><b style={{ color: "#0D0D0D", fontWeight: 500 }}>{q.header}</b> {q.question}</>)}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {q.options.map((o) => {
              const value = o.value ?? o.label;
              const on = answers[q.id]?.includes(value) ?? false;
              return <span key={value} {...(btn(o.label, () => {
                setAnswers((a) => {
                  const cur = a[q.id] ?? [];
                  return { ...a, [q.id]: q.multiSelect ? (on ? cur.filter((x) => x !== value) : [...cur, value]) : (on ? [] : [value]) };
                });
                // Single choice: picking an option replaces a typed answer, so what is sent is what is shown.
                if (!q.multiSelect && !on) setCustom((c) => ({ ...c, [q.id]: "" }));
              }, { "aria-pressed": on, title: o.description }) as object)}
                style={{ padding: "4px 10px", borderRadius: 8, fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 13, lineHeight: "18px", color: on ? "#FFFFFF" : "#0D0D0D", background: on ? "#0D0D0D" : "#FFFFFF", boxShadow: "#DFDFDF 0px 0px 0px 1px inset" }}>{o.label}</span>;
            })}
          </div>
          {canType(q) && <input aria-label={`Answer: ${q.header}`} value={typedOf(q)} onChange={(e) => { const v = e.target.value; setCustom((c) => ({ ...c, [q.id]: v })); if (!q.multiSelect && v !== "") setAnswers((a) => ({ ...a, [q.id]: [] })); }}
            style={{ all: "unset", padding: "6px 10px", border: "1px solid #ECECEC", borderRadius: 8, fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 13, lineHeight: "18px", color: "#0D0D0D" }} />}
        </div>
      ))}
    </div>;
    const payload: Record<string, string | string[]> = {};
    for (const q of item.questions) {
      const picked = answers[q.id] ?? [];
      const typed = typedOf(q);
      const all = typed.trim() !== "" ? [...picked, typed] : picked;
      if (all.length) payload[q.id] = q.multiSelect ? all : all[0]!;
    }
    buttons = [action("answered", "Answer", true, { outcome: "answered", answers: payload }, missing.length ? "Answer the required questions first" : undefined, missing.length > 0), notNow];
  } else if (request.kind === "resend") {
    buttons = [action("resend", "Resend", true, { outcome: "resend" }, "Send the message again"), action("dropped", "Drop", false, { outcome: "dropped" })];
  } else if (request.kind === "approval" || request.kind === "question") {
    // Fail closed: without the engine's waiting item we do not know the offered choices.
    body = <>{body}{text(onLoadDetails ? "The details are in an earlier part of this thread." : "Waiting for the details of this request from the host.")}</>;
    buttons = onLoadDetails ? [<P.DecisionSecondary key="load" label="Load details" button={btn("Load details", onLoadDetails, { "data-option": "load" })} />, notNow] : [notNow];
  } else {
    body = body ?? "Signing in from here is not built yet.";
    buttons = [notNow, <Planned key="p" id="settings-accounts" style={{ alignSelf: "center" }} />];
  }
  return (
    <div data-request={request.requestId}>
      <P.DecisionCard title={title} body={body} buttons={<P.DecisionButtons>{buttons}</P.DecisionButtons>} />
      {error && <div role="alert" style={{ color: "#5D5D5D", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 12, padding: "6px 4px" }}>{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- right panel

function Overview({ bot, scene, onOpenTask, onEdit }: { bot: BotRowData; scene: string | null; onOpenTask: (id: string) => void; onEdit: () => void }) {
  const snap = useHost();
  const { now } = useHostContext();
  const parent = useThread(bot.threadId);
  const workers = bot.threadId ? workerThreads(snap.state, bot.threadId) : [];
  const childTimes = new Map<string, string>();
  for (const e of parent.entries) if (e.kind === "child" && e.reported) childTimes.set(e.childThreadId, duration(e.at, e.reported.at));
  return (
    <P.Panel>
      <P.PanelHeader face={<Face bot={bot} size={44} live />} name={bot.name} purpose={bot.purpose} edit={btn(`${bot.name} settings`, onEdit, { title: `${bot.name} settings` })} editIcon={<P.PanelEditIcon />} />
      <P.PanelTabs home={{ "aria-selected": true, role: "tab" }} library={plannedProps("library-memory")} />
      {scene === "U8-1" && <P.AsleepCard wake={plannedProps("machines")} other={plannedProps("machines")} />}
      <P.PanelSection label="Machines" extra={<Planned id="machines" style={{ marginLeft: 6 }} />}>{null}</P.PanelSection>
      {workers.length > 0 && (
        <P.PanelSectionCount label="Tasks" count={workers.length}>
          {workers.map((c) => (
            <P.TaskRow key={c.id} icon={c.status === "running" ? <span data-spin="" style={{ display: "inline-flex" }}><P.TaskRunningIcon /></span> : <P.TaskDoneIcon />}
              title={c.title} meta={c.status === "running" ? "Working" : childTimes.get(c.id) ?? shortTime(c.updatedAt, now()).toLowerCase()}
              root={btn(c.title, () => onOpenTask(c.id), { "data-task": c.id })} />
          ))}
        </P.PanelSectionCount>
      )}
      <P.RoutinesSection extra={<Planned id="routines" style={{ marginLeft: 6 }} />} />
    </P.Panel>
  );
}
