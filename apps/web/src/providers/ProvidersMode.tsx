// Providers (boards 1PBB-2, 1Q0P-2, 1QAN-2, 2LET-2, 2LEU-2, 2LEV-2): the GOAT 2 frame with a flat sidebar of the
// providers you added and the selected one, the catalog or the first run in the main pane. Data: the host's provider
// list through the provider port (providers/context.tsx); look: the boards (providers/ui.tsx).
import { useState, type ReactNode } from "react";
import * as P from "../paper/parts.tsx";
import { useHostContext } from "../host/HostProvider.tsx";
import type { UiState } from "../ui-state/uiState.ts";
import { useAction, useProviderCall, useProviderEntries } from "./context.tsx";
import { ProviderDetail } from "./ProviderDetail.tsx";
import { Catalog } from "./Catalog.tsx";
import { FirstRun } from "./FirstRun.tsx";
import { addedProviders, ago, matches, providerState, rowLine, title, iconOf } from "./view.ts";
import { DotMark, FAINT, INK, Logo, MUTED, Plus, text } from "./ui.tsx";

type SetUi = (patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => void;

export function ProvidersMode({ ui, setUi, top, rail }: { ui: UiState; setUi: SetUi; top: ReactNode; rail: ReactNode }) {
  const entries = useProviderEntries();
  const now = useHostContext().now().getTime();
  const keptOff = ui.providersKeptOff ?? [];
  const hidden = ui.providersHidden ?? [];
  const added = entries ? addedProviders(entries, keptOff, hidden) : [];
  const view = ui.settingsSearch?.view === "add" ? "add" : "detail";
  const wanted = ui.settingsSearch?.instanceId;
  const selected = added.find((e) => e.instanceId === wanted) ?? added[0] ?? null;
  const select = (instanceId: string) => setUi({ settingsSearch: { instanceId } });
  const openCatalog = () => setUi({ settingsSearch: { view: "add" } });
  // Switched off here: stays listed. Switched on or added again: no longer hidden.
  const setKeptOff = (instanceId: string, kept: boolean) => setUi((s) => {
    const list = (s.providersKeptOff ?? []).filter((id) => id !== instanceId);
    return { providersKeptOff: kept ? [...list, instanceId] : list, providersHidden: (s.providersHidden ?? []).filter((id) => id !== instanceId) };
  });
  const hide = (instanceId: string) => setUi((s) => ({
    providersKeptOff: (s.providersKeptOff ?? []).filter((id) => id !== instanceId),
    providersHidden: [...(s.providersHidden ?? []).filter((id) => id !== instanceId), instanceId],
  }));

  let main: ReactNode;
  if (!entries) main = <Centered>Loading providers…</Centered>;
  else if (view === "add") main = <Catalog entries={entries} keptOff={keptOff} hidden={hidden} onAdded={(id) => { setKeptOff(id, false); select(id); }} />;
  else if (!selected) main = <FirstRun entries={entries} keptOff={keptOff} hidden={hidden} onAdded={(id) => { setKeptOff(id, false); select(id); }} onBrowse={openCatalog} />;
  else main = <ProviderDetail entry={selected} now={now} onKeptOff={setKeptOff} onRemoved={hide} onSelect={select} />;

  const sidebar = ui.sidebarOpen ? (
    <ProvidersSidebar entries={added} checkedAt={entries ? latestCheck(entries.map((e) => e.probe.checkedAt)) : null} now={now}
      selected={view === "add" ? null : selected?.instanceId ?? null} catalogOpen={view === "add"} onSelect={select} onAdd={openCatalog} />
  ) : null;
  return (
    <P.Frame top={top} rail={rail} sidebar={sidebar}
      main={<div data-providers-main="" style={{ backgroundColor: "#FFFFFF", display: "flex", flex: "1 1 0%", justifyContent: "center", minWidth: 0, minHeight: 0, overflow: "auto" }}>{main}</div>} />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", ...text(13, MUTED) }}>{children}</div>;
}

const latestCheck = (all: string[]) => all.reduce<string | null>((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);

function ProvidersSidebar({ entries, checkedAt, now, selected, catalogOpen, onSelect, onAdd }: {
  entries: ReturnType<typeof addedProviders>; checkedAt: string | null; now: number; selected: string | null; catalogOpen: boolean;
  onSelect: (instanceId: string) => void; onAdd: () => void;
}) {
  const call = useProviderCall();
  const act = useAction();
  const [query, setQuery] = useState("");
  const shown = entries.filter((e) => matches(e, query));
  return (
    <nav aria-label="Providers" data-providers-sidebar="" style={{ backgroundColor: "#F7F7F7", borderRight: "1px solid #ECECEC", boxSizing: "border-box", display: "flex", flexDirection: "column", flexShrink: 0, gap: 2, paddingBottom: 8, paddingInline: 8, paddingTop: 10, width: 256, minHeight: 0 }}>
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", paddingBottom: 8, paddingInline: 8, paddingTop: 4 }}>
        <div style={text(13, INK, 600)}>Providers</div>
        <button type="button" aria-label="Check all providers again" title={act.error ?? "Check all providers again"} disabled={act.busy !== null}
          onClick={() => void act.run("refresh", () => call("server.refreshProviders", {}))}
          style={{ all: "unset", alignItems: "center", display: "flex", gap: 6, cursor: "pointer" }}>
          <span style={text(11, act.error ? "#D83A3A" : FAINT)}>{act.busy ? "Checking\u2026" : act.error ? "Check failed" : checkedAt ? `Checked ${ago(checkedAt, now)}` : ""}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke={FAINT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <label style={{ alignItems: "center", backgroundColor: "#EDEDED", borderRadius: 8, display: "flex", flexShrink: 0, gap: 8, height: 32, marginBottom: 8, paddingInline: 10 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke={FAINT} strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke={FAINT} strokeWidth="2" strokeLinecap="round" /></svg>
        <input aria-label="Search providers" placeholder="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} style={{ all: "unset", flex: 1, minWidth: 0, ...text(13) }} />
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "auto", minHeight: 0 }}>
        {shown.map((e) => {
          const s = providerState(e);
          const on = e.instanceId === selected;
          return (
            <button key={e.instanceId} type="button" data-provider-row={e.instanceId} aria-current={on ? "page" : undefined} onClick={() => onSelect(e.instanceId)}
              style={{ all: "unset", boxSizing: "border-box", alignItems: "center", borderRadius: 8, display: "flex", gap: 10, paddingBlock: 8, paddingInline: 10, cursor: "pointer", ...(on ? { backgroundColor: "#E9E9E9" } : {}) }}>
              <Logo icon={iconOf(e)} />
              <span style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", minWidth: 0 }}>
                <span style={{ ...text(13, INK, 500), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title(e)}</span>
                <span style={{ alignItems: "center", display: "flex", gap: 6 }}>
                  <DotMark dot={s.dot} />
                  <span style={{ ...text(12, MUTED), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rowLine(e)}</span>
                </span>
              </span>
            </button>
          );
        })}
        {query && shown.length === 0 ? <div style={{ ...text(12, FAINT), padding: "8px 10px" }}>No provider matches.</div> : null}
      </div>
      <div style={{ flex: "1 1 0%" }} />
      <button type="button" onClick={onAdd} aria-current={catalogOpen ? "page" : undefined}
        style={{ all: "unset", boxSizing: "border-box", alignItems: "center", borderRadius: 8, display: "flex", gap: 8, paddingBlock: 9, paddingInline: 10, cursor: "pointer", ...(catalogOpen ? { backgroundColor: "#E9E9E9" } : {}) }}>
        <Plus /><span style={text(13, INK, 500)}>Add a provider</span>
      </button>
    </nav>
  );
}

