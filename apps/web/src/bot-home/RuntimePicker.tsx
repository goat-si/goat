// Runtime picker: one popover that sets which CLI (provider driver) and model a bot runs on.
// Opens from the chat runtime bar and from the composer chip; both read and write the same
// per-bot runtime, so the roster chip, runtime bar, composer and Overview → Runtime stay in sync.
// Keyboard: Enter/Space opens, ↑/↓ moves, Enter picks, Esc closes and returns focus.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import { accountFor, catalog, type BotRuntime } from "./placeholder.ts";

const ink = "#111113";
const muted = "#5E5E64";
const faint = "#8A8A90";
const line = "#ECECEE";
const mono: CSSProperties = { fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12 };
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

interface Option { driver: string; label: string; model: string; }
const options: Option[] = catalog.flatMap((c) => c.models.map((model) => ({ driver: c.driver, label: c.label, model })));

export function RuntimePicker(props: {
  value: BotRuntime;
  onChange: (next: BotRuntime) => void;
  /** Where the popover opens relative to the trigger. */
  placement: "below" | "above";
  variant: "bar" | "composer";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.driver === props.value.driver && o.model === props.value.model)));
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, props.value.driver, props.value.model]);

  const pick = (o: Option) => {
    props.onChange({ ...props.value, driver: o.driver, model: o.model, account: accountFor[o.driver] ?? props.value.account });
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length); }
    else if (e.key === "Enter") { e.preventDefault(); const o = options[active]; if (o) pick(o); }
  };

  const bar = props.variant === "bar";
  return (
    <div ref={rootRef} style={{ position: "relative" }} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Runtime: ${props.value.model}. Change CLI or model`}
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
          padding: bar ? "4px 10px 4px 6px" : "5px 10px 5px 6px", borderRadius: 9999,
          background: open ? "#E9E9EC" : "#F2F2F3", transition: `background-color 100ms ${EASE}`,
        }}
      >
        {/* Paper SSOT: white disc (18px bar / 20px composer) holding the real provider mark */}
        <span style={{ width: bar ? 18 : 20, height: bar ? 18 : 20, borderRadius: 9999, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <ProviderGlyph driver={props.value.driver} size={bar ? 11 : 12} />
        </span>
        <span style={{ ...mono, color: "#3A3A3F" }}>{props.value.model}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={faint} strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: `transform 200ms ${EASE}` }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="CLI and model"
          style={{
            position: "absolute", zIndex: 20, width: 280, maxHeight: 360, overflow: "auto",
            [props.placement === "below" ? "top" : "bottom"]: "calc(100% + 6px)",
            left: bar ? "50%" : "auto", right: bar ? "auto" : 0, transform: bar ? "translateX(-50%)" : "none",
            background: "#fff", border: `1px solid ${line}`, borderRadius: 12, padding: 6,
            boxShadow: "0 10px 15px -3px rgba(0,0,0,.08), 0 4px 6px -4px rgba(0,0,0,.06)",
            animation: `goat2-pop 200ms ${EASE}`,
          }}
        >
          <style>{"@keyframes goat2-pop{from{opacity:0;transform:translate(var(--tx,0),4px)}to{opacity:1}}@media (prefers-reduced-motion: reduce){[role=listbox]{animation:none!important}}"}</style>
          {catalog.map((group) => (
            <div key={group.driver} role="group" aria-label={group.label}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px 4px" }}>
                <ProviderGlyph driver={group.driver} size={12} />
                <span style={{ fontSize: 12, fontWeight: 600, color: muted }}>{group.label}</span>
                <span style={{ ...mono, fontSize: 11, color: faint, marginLeft: "auto" }}>{group.version}</span>
              </div>
              {group.models.map((model) => {
                const idx = options.findIndex((o) => o.driver === group.driver && o.model === model);
                const selected = props.value.driver === group.driver && props.value.model === model;
                return (
                  <div
                    key={model}
                    role="option"
                    aria-selected={selected}
                    onPointerEnter={() => setActive(idx)}
                    onClick={() => pick(options[idx]!)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "7px 8px 7px 28px", borderRadius: 8, cursor: "pointer",
                      background: idx === active ? "#F2F2F3" : "transparent",
                    }}
                  >
                    <span style={{ ...mono, color: ink, flex: 1 }}>{model}</span>
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
