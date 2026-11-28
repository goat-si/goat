// "Add a provider" (board 1QAN-2): one catalog in the main pane. Built-in kinds, v1's local presets, the ACP registry
// and cloud platforms, ordered On this Mac -> More, with outcome badges and the All / Ready on this Mac / Cloud filters.
import { useEffect, useMemo, useState } from "react";
import type { AcpRegistrySearchAgent, AcpRegistrySearchResult, ServerProviderEntry } from "./wire.ts";
import { useAction, useProviderCall } from "./context.tsx";
import { catalog, type CatalogFilter, type CatalogItem } from "./view.ts";
import { Button, ErrorLine, FAINT, INK, LINE, Logo, MUTED, Plus, text } from "./ui.tsx";
import { openUrl } from "./ProviderDetail.tsx";

const FILTERS: Array<[CatalogFilter, string]> = [["all", "All"], ["ready", "Ready on this Mac"], ["cloud", "Cloud"]];

export function Catalog({ entries, keptOff, onAdded }: { entries: ServerProviderEntry[]; keptOff: string[]; onAdded: (instanceId: string) => void }) {
  const call = useProviderCall();
  const act = useAction();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [registry, setRegistry] = useState<AcpRegistrySearchAgent[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      call<AcpRegistrySearchResult>("server.searchAcpRegistry", { query: query.trim(), limit: 20 })
        .then((r) => { if (live) { setRegistry([...(r?.agents ?? [])]); setRegistryError(null); } })
        .catch((e: unknown) => { if (live) { setRegistry([]); setRegistryError(e instanceof Error ? e.message : String(e)); } });
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [call, query]);
  const items = useMemo(() => catalog(entries, keptOff, registry, filter, query), [entries, keptOff, registry, filter, query]);
  const mac = items.filter((i) => i.section === "mac");
  const more = items.filter((i) => i.section === "more");
  const firstAction = items.find((i) => i.action.kind === "enable" || i.action.kind === "install" || i.action.kind === "registry")?.key;

  const perform = (i: CatalogItem) => act.run(i.key, async () => {
    const a = i.action;
    if (a.kind === "enable") {
      await call("goat2.setProviderInstance", { instanceId: a.instanceId, driver: a.driver, enabled: true });
      onAdded(a.instanceId);
    } else if (a.kind === "install") {
      await call("goat2.setProviderInstance", { instanceId: a.instanceId, driver: a.driver, enabled: true });
      await call("providerInstall.start", { instanceId: a.instanceId });
      onAdded(a.instanceId);
    } else if (a.kind === "registry") {
      await call("server.prepareAcpRegistryAgent", { agentId: a.agentId });
      const instanceId = `acp-${a.agentId}`;
      await call("goat2.setProviderInstance", { instanceId, driver: "acpRegistry", acpAgentId: a.agentId, enabled: true, displayName: a.name });
      onAdded(instanceId);
    } else if (a.kind === "copy") {
      await navigator.clipboard?.writeText(a.text);
      setCopied(i.key);
    }
  });

  return (
    <div data-provider-catalog="" style={{ display: "flex", flexDirection: "column", maxWidth: 760, paddingBlock: 28, paddingInline: 32, width: "100%", boxSizing: "border-box" }}>
      <h1 style={{ margin: 0, ...text(20, INK, 600) }}>Add a provider</h1>
      <div style={{ ...text(13, MUTED), marginTop: 4 }}>Coding agents GOAT can run for you. Ones already on this Mac come first; GOAT installs the rest.</div>
      <label style={{ alignItems: "center", backgroundColor: "#F3F3F3", borderRadius: 10, display: "flex", flexShrink: 0, gap: 8, height: 36, marginTop: 16, paddingInline: 12 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke={FAINT} strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke={FAINT} strokeWidth="2" strokeLinecap="round" /></svg>
        <input aria-label="Search providers and agents" placeholder="Search providers and agents" value={query} onChange={(e) => setQuery(e.target.value)}
          style={{ all: "unset", flex: 1, ...text(13) }} />
      </label>
      <div role="radiogroup" aria-label="Show" style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}
            style={{ all: "unset", boxSizing: "border-box", alignItems: "center", borderRadius: 99, display: "flex", height: 28, paddingInline: 12, cursor: "pointer",
              ...(filter === id ? { backgroundColor: INK } : { boxShadow: "#DFDFDF 0px 0px 0px 1px inset" }) }}>
            <span style={text(12, filter === id ? "#FFFFFF" : INK, 500)}>{label}</span>
          </button>
        ))}
      </div>
      <ErrorLine error={act.error} />
      {mac.length > 0 ? <Group title="On this Mac" first items={mac} primary={firstAction} busy={act.busy} copied={copied} onAct={perform} /> : null}
      {more.length > 0 ? <Group title="More" items={more} primary={firstAction} busy={act.busy} copied={copied} onAct={perform} /> : null}
      {items.length === 0 ? <div style={{ ...text(13, MUTED), marginTop: 16 }}>Nothing matches {query ? `\u201c${query}\u201d` : "this filter"}.</div> : null}
      {registryError ? <div style={{ ...text(12, FAINT), marginTop: 8 }}>Registry agents are not available: {registryError}</div> : null}
      <div style={{ alignItems: "center", display: "flex", gap: 8, marginTop: 14, paddingInline: 4 }} title="Adding an agent by its own command needs a host command GOAT 2 does not have yet.">
        <Plus /><span style={{ ...text(13, INK, 500), opacity: 0.5 }}>Add a custom agent</span>
        <span style={text(12, FAINT)}>for any agent that speaks ACP: you give the command (coming later)</span>
      </div>
    </div>
  );
}

function Group({ title, items, first, primary, busy, copied, onAct }: {
  title: string; items: CatalogItem[]; first?: boolean; primary: string | undefined; busy: string | null; copied: string | null; onAct: (i: CatalogItem) => void;
}) {
  return (
    <section aria-label={title} style={{ marginTop: first ? 16 : 14 }}>
      <div style={{ paddingBlock: 6, paddingInline: 4 }}>
        <div style={{ ...text(12, FAINT, 600), letterSpacing: "0.02em", textTransform: "uppercase" }}>{title}</div>
      </div>
      {items.map((i) => (
        <div key={i.key} data-catalog-item={i.key} style={{ alignItems: "center", borderTop: `1px solid ${LINE}`, display: "flex", gap: 12, paddingBlock: 12, paddingInline: 4 }}>
          <Logo icon={i.icon} tile={32} />
          <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={text(14, INK, 600)}>{i.name}</div>
            <div style={text(12, MUTED)}>{i.blurb}</div>
          </div>
          <div style={text(12, i.badge === "Added" ? FAINT : MUTED, 500)}>{i.badge}</div>
          <ItemAction i={i} primary={primary === i.key} busy={busy === i.key} copied={copied === i.key} onAct={onAct} />
        </div>
      ))}
    </section>
  );
}

function ItemAction({ i, primary, busy, copied, onAct }: { i: CatalogItem; primary: boolean; busy: boolean; copied: boolean; onAct: (i: CatalogItem) => void }) {
  const a = i.action;
  if (a.kind === "none") return a.reason ? <Button disabled title={a.reason}>Add</Button> : null;
  if (a.kind === "copy") return (
    <>
      <Button onClick={() => openUrl(a.docsUrl)}>Docs</Button>
      <Button onClick={() => onAct(i)} disabled={busy}>{copied ? "Copied" : "Copy install command"}</Button>
    </>
  );
  const label = a.kind === "enable" ? "Add" : "Install and add";
  return <Button primary={primary} onClick={() => onAct(i)} disabled={busy}>{busy ? (a.kind === "enable" ? "Adding\u2026" : "Installing\u2026") : label}</Button>;
}

