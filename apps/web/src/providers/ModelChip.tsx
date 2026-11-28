// The model chip and picker (boards 1QM8-2 composer, 1QYE-2 bot settings): a provider rail (favourites, the providers
// you added, greyed while they need you, + to add one), the selected provider's models with stars, the reasoning
// options the model offers, and a line that routes sign-in to Providers (principle 8: pickers pick). The choice
// applies from the thread's next turn through change_thread (docs/part2/provider-wire.md); a composer without a
// thread yet keeps it for start_thread.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useClient } from "../host/HostProvider.tsx";
import { resolveModelShortName } from "../v1/packages/client-runtime/src/modelShortName.ts";
import { useProviderEntries } from "./context.tsx";
import { favoriteKey, toggleFavorite, useFavorites } from "./favorites.ts";
import { openProviders } from "./navigation.ts";
import { addedProviders, providerState, title, iconOf } from "./view.ts";
import type { ServerProviderEntry, ServerProviderModel } from "./wire.ts";
import { DotMark, FAINT, INK, LINE, Logo, MUTED, text } from "./ui.tsx";

export interface Selection { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> }

/** What a thread without a card runs until the person picks (the GOAT 2 default since Part 1). */
export const DEFAULT_SELECTION: Selection = { instanceId: "codex", model: "gpt-6.1-sol" };

/** change_thread on a thread, or null when there is no thread to change. */
export function useThreadModelChange(threadId: string | null) {
  const client = useClient();
  const [error, setError] = useState<string | null>(null);
  const change = threadId === null ? null : (selection: Selection) => {
    setError(null);
    void client.command({ type: "change_thread", threadId, modelSelection: {
      instanceId: selection.instanceId, model: selection.model, ...(selection.options?.length ? { options: selection.options } : {}),
    } }).then((r) => {
      if (!r.ok) setError(r.error?.message ?? "Could not change the model.");
    });
  };
  return { change, error };
}

const REASONING = "reasoningEffort";
const reasoningOf = (m: ServerProviderModel | undefined) => {
  const d = m?.capabilities?.optionDescriptors?.find((o) => o.id === REASONING);
  return d && d.type === "select" ? d : null;
};
const effortOf = (selection: Selection, m: ServerProviderModel | undefined) => {
  const r = reasoningOf(m);
  const v = selection.options?.find((o) => o.id === REASONING)?.value;
  return { r, id: typeof v === "string" ? v : r?.currentValue ?? r?.options.find((o) => o.isDefault)?.id };
};

export function ModelChip({ selection, onChange, label, disabled, error, variant = "composer" }: {
  selection: Selection;
  onChange: ((selection: Selection) => void) | null;
  /** Whose model it is, for the trigger's accessible name ("Reviewer", "Thread"). */
  label: string;
  disabled?: boolean;
  error?: string | null;
  /** composer: the compact chip that opens upward; field: the bot settings row that opens below. */
  variant?: "composer" | "field";
}) {
  const entries = useProviderEntries() ?? [];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const entry = entries.find((e) => e.instanceId === selection.instanceId);
  const model = entry?.probe.models.find((m) => m.slug === selection.model);
  const short = model ? resolveModelShortName(model, entry?.driver) ?? model.name : selection.model;
  const { r: reasoning, id: effortId } = effortOf(selection, model);
  const effort = reasoning?.options.find((o) => o.id === effortId)?.label ?? null;
  const off = disabled === true || onChange === null;
  const driver = entry?.driver ?? (selection.instanceId.split("-")[0] ?? "codex");
  const trigger = variant === "composer" ? (
    <span style={{ alignItems: "center", backgroundColor: "#F3F3F3", borderRadius: 8, display: "flex", gap: 6, height: 28, paddingInline: 8 }}>
      <Logo icon={entry ? iconOf(entry) : { driver }} />
      <span style={text(13, INK, 500)}>{short}</span>
      {effort ? <span style={text(12, FAINT)}>{effort}</span> : null}
    </span>
  ) : (
    <span style={{ alignItems: "center", borderRadius: 8, boxShadow: "#DFDFDF 0px 0px 0px 1px inset", display: "flex", gap: 6, height: 30, paddingInline: 10 }}>
      <Logo icon={entry ? iconOf(entry) : { driver }} />
      <span style={text(13, INK, 500)}>{[entry ? title(entry) : selection.instanceId, short, effort].filter(Boolean).join(" \u00b7 ")}</span>
    </span>
  );
  return (
    <div ref={ref} data-model-chip="" style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button type="button" aria-label={`${label} model: ${selection.model}`} aria-haspopup="dialog" aria-expanded={open} disabled={off}
        onClick={() => setOpen((o) => !o)} style={{ all: "unset", cursor: off ? "default" : "pointer", opacity: off ? 0.6 : 1 }}>{trigger}</button>
      {error ? <span role="alert" title={error} style={{ ...text(12, "#D83A3A"), maxWidth: 224, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error}</span> : null}
      {open && onChange ? (
        <div style={{ position: "absolute", zIndex: 30, ...(variant === "composer" ? { bottom: 36, right: 0 } : { top: 36, left: 0 }) }}>
          <ModelPicker entries={entries} selection={selection} width={variant === "composer" ? 420 : 440} onPick={onChange} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

export function ModelPicker({ entries, selection, width, onPick, onClose }: {
  entries: ServerProviderEntry[]; selection: Selection; width: number; onPick: (s: Selection) => void; onClose: () => void;
}) {
  const favorites = useFavorites();
  const providers = useMemo(() => addedProviders(entries, []).filter((e) => e.enabled), [entries]);
  const [tab, setTab] = useState<string>(providers.some((p) => p.instanceId === selection.instanceId) ? selection.instanceId : "favorites");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows: Array<{ entry: ServerProviderEntry; model: ServerProviderModel }> = [];
  for (const p of providers) {
    if (!q && tab !== "favorites" && p.instanceId !== tab) continue;
    for (const m of p.probe.models) {
      if (tab === "favorites" && !q && !favorites.includes(favoriteKey(p.instanceId, m.slug))) continue;
      if (q && !`${m.name} ${m.slug} ${title(p)}`.toLowerCase().includes(q)) continue;
      rows.push({ entry: p, model: m });
    }
  }
  const current = providers.find((p) => p.instanceId === selection.instanceId);
  const { r: reasoning, id: effortId } = effortOf(selection, current?.probe.models.find((m) => m.slug === selection.model));
  const needing = providers.filter((p) => providerState(p).need === "sign-in");
  const tabEntry = providers.find((p) => p.instanceId === tab);
  const header = q ? "Results" : tab === "favorites" || !tabEntry ? "Favorites" : title(tabEntry);
  const pick = (entry: ServerProviderEntry, model: ServerProviderModel) => {
    const keep = entry.instanceId === selection.instanceId && model.slug === selection.model ? selection.options : undefined;
    onPick({ instanceId: entry.instanceId, model: model.slug, ...(keep ? { options: keep } : {}) });
    onClose();
  };
  return (
    <div role="dialog" aria-label="Choose a model" style={{ backgroundColor: "#FFFFFF", borderRadius: 14, boxShadow: "#ECECEC 0px 0px 0px 1px, #0000001A 0px 12px 32px", display: "flex", overflow: "clip", width }}>
      <div role="group" aria-label="Providers" style={{ alignItems: "center", borderRight: `1px solid ${LINE}`, display: "flex", flexDirection: "column", flexShrink: 0, gap: 4, paddingBlock: 8, width: 48 }}>
        <RailButton label="Favorites" active={tab === "favorites"} onClick={() => setTab("favorites")}>
          <Star filled />
        </RailButton>
        <div style={{ backgroundColor: "#ECECEC", flexShrink: 0, height: 1, marginBlock: 2, width: 18 }} />
        {providers.map((p) => {
          const need = providerState(p).need;
          return (
            <RailButton key={p.instanceId} label={title(p)} active={tab === p.instanceId} dim={need !== "none" && need !== "unknown"} onClick={() => setTab(p.instanceId)}>
              <Logo icon={iconOf(p)} />
            </RailButton>
          );
        })}
        <div style={{ flex: "1 1 0%" }} />
        <RailButton label="Add a provider" active={false} onClick={() => { onClose(); openProviders({ view: "add" }); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" /></svg>
        </RailButton>
      </div>
      <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", padding: 8, minWidth: 0 }}>
        <label style={{ alignItems: "center", backgroundColor: "#F3F3F3", borderRadius: 8, display: "flex", flexShrink: 0, gap: 8, height: 32, marginBottom: 6, paddingInline: 10 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke={FAINT} strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke={FAINT} strokeWidth="2" strokeLinecap="round" /></svg>
          <input autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} style={{ all: "unset", flex: 1, minWidth: 0, ...text(13) }} />
        </label>
        <div style={{ paddingBottom: 2, paddingInline: 10, paddingTop: 6 }}>
          <div style={{ ...text(11, FAINT, 600), letterSpacing: "0.02em", textTransform: "uppercase" }}>{header}</div>
        </div>
        <div role="list" aria-label="Models" style={{ display: "flex", flexDirection: "column", maxHeight: 256, overflow: "auto" }}>
          {rows.map(({ entry, model }) => {
            const selected = entry.instanceId === selection.instanceId && model.slug === selection.model;
            const fav = favorites.includes(favoriteKey(entry.instanceId, model.slug));
            const need = providerState(entry).need;
            const blocked = need === "sign-in" || need === "install" || need === "repair";
            return (
              <div key={`${entry.instanceId}/${model.slug}`} role="listitem"
                style={{ alignItems: "center", borderRadius: 8, display: "flex", flexShrink: 0, gap: 10, height: 32, paddingInline: 10, ...(selected ? { backgroundColor: "#F3F3F3" } : {}), opacity: blocked ? 0.5 : 1 }}>
                <button type="button" aria-pressed={selected} disabled={blocked} onClick={() => pick(entry, model)} title={blocked ? `${title(entry)} needs you first: open Providers.` : undefined}
                  style={{ all: "unset", flex: "1 1 0%", minWidth: 0, cursor: blocked ? "default" : "pointer", ...text(13, INK, selected ? 500 : undefined), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {model.name}{q || tab === "favorites" ? <span style={{ color: FAINT }}> · {title(entry)}</span> : null}
                </button>
                <button type="button" aria-label={fav ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`} aria-pressed={fav}
                  onClick={() => toggleFavorite(favoriteKey(entry.instanceId, model.slug))} style={{ all: "unset", cursor: "pointer", display: "flex", width: 14 }}>
                  <Star filled={fav} />
                </button>
                <span style={{ display: "flex", width: 14 }}>{selected ? <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}</span>
              </div>
            );
          })}
          {rows.length === 0 ? <div style={{ ...text(12, FAINT), padding: "8px 10px" }}>{tab === "favorites" && !q ? "Star a model to keep it here." : q ? "No model matches." : "This provider has not reported its models yet."}</div> : null}
        </div>
        {reasoning ? (
          <div role="group" aria-label={reasoning.label} style={{ alignItems: "center", borderTop: `1px solid ${LINE}`, display: "flex", gap: 8, marginTop: 6, paddingBottom: 6, paddingInline: 10, paddingTop: 10 }}>
            <div style={{ ...text(12, MUTED), flex: "1 1 0%" }}>Reasoning</div>
            {reasoning.options.map((o) => {
              const on = o.id === effortId;
              return (
                <button key={o.id} type="button" aria-pressed={on}
                  onClick={() => onPick({ ...selection, options: [...(selection.options ?? []).filter((x) => x.id !== REASONING), { id: REASONING, value: o.id }] })}
                  style={{ all: "unset", boxSizing: "border-box", alignItems: "center", borderRadius: 6, display: "flex", height: 24, paddingInline: 9, cursor: "pointer",
                    ...(on ? { backgroundColor: INK } : { boxShadow: "#DFDFDF 0px 0px 0px 1px inset" }) }}>
                  <span style={text(12, on ? "#FFFFFF" : INK, 500)}>{o.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {needing.length > 0 ? (
          <div style={{ alignItems: "center", backgroundColor: "#F4F7FE", borderRadius: 8, display: "flex", gap: 8, marginTop: 4, paddingBlock: 8, paddingInline: 10 }}>
            <DotMark dot="blue" />
            <span style={{ ...text(12), flex: "1 1 0%" }}>{joinNames(needing.map((p) => title(p)))} need{needing.length === 1 ? "s" : ""} sign-in.</span>
            <button type="button" onClick={() => { onClose(); openProviders({ instanceId: needing[0]!.instanceId }); }}
              style={{ all: "unset", cursor: "pointer", ...text(12, INK, 600) }}>Open Providers</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill={filled ? INK : "none"} stroke={filled ? INK : "#BDBDBD"} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function RailButton({ children, label, active, dim, onClick }: { children: ReactNode; label: string; active: boolean; dim?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} aria-label={label} title={label} onClick={onClick}
      style={{ all: "unset", alignItems: "center", borderRadius: 8, display: "flex", flexShrink: 0, height: 32, justifyContent: "center", width: 32, cursor: "pointer",
        ...(active ? { backgroundColor: "#EDEDED" } : {}), ...(dim ? { opacity: 0.4 } : {}) }}>{children}</button>
  );
}

const joinNames = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

