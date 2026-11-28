// Small building blocks of the provider boards (1PBB-2 and siblings). Every value is copied from the board export
// (design/paper/part2/*.jsx): type sizes, colours, radii, spacing. No values that are not on the boards.
import type { CSSProperties, ReactNode } from "react";
import { ProviderGlyph } from "@goat2/provider-icons";
import { DOT_COLOR, type Dot } from "./view.ts";

export const FONT = '"SF Pro", system-ui, sans-serif';
export const INK = "#0D0D0D", MUTED = "#5D5D5D", FAINT = "#8F8F8F", LINE = "#F0F0F0";
export const text = (size: 11 | 12 | 13 | 14 | 15 | 18 | 20, color = INK, weight?: 500 | 600): CSSProperties => ({
  fontFamily: FONT, fontSize: size, color, lineHeight: { 11: "15px", 12: "17px", 13: "18px", 14: "20px", 15: "21px", 18: "25px", 20: "28px" }[size],
  ...(weight ? { fontWeight: weight } : {}),
});

export function Button({ children, primary, onClick, disabled, title, label }: {
  children: ReactNode; primary?: boolean; onClick?: () => void; disabled?: boolean; title?: string; label?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={label}
      style={{ all: "unset", boxSizing: "border-box", display: "flex", alignItems: "center", height: 28, paddingInline: 12, borderRadius: 8, cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1, flexShrink: 0,
        ...(primary ? { backgroundColor: INK } : { boxShadow: "#DFDFDF 0px 0px 0px 1px inset" }) }}>
      <span style={{ ...text(13, primary ? "#FFFFFF" : INK, 500), lineHeight: "16px", whiteSpace: "nowrap" }}>{children}</span>
    </button>
  );
}

export function DotMark({ dot }: { dot: Dot }) {
  return <span data-dot={dot} style={{ backgroundColor: DOT_COLOR[dot], borderRadius: 99, flexShrink: 0, height: 7, width: 7, display: "inline-block" }} />;
}

export function Toggle({ on, onChange, disabled, label, title }: { on: boolean; onChange?: (on: boolean) => void; disabled?: boolean; label: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled} onClick={() => onChange?.(!on)}
      style={{ all: "unset", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: on ? "end" : "start", flexShrink: 0, height: 18, width: 30, padding: 2,
        borderRadius: 99, backgroundColor: on ? INK : "#D9D9D9", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      <span style={{ backgroundColor: "#FFFFFF", borderRadius: 99, height: 14, width: 14 }} />
    </button>
  );
}

/** Provider logo: the real mark (@goat2/provider-icons) or a registry icon, on the board's grey tile when sized. */
export function Logo({ icon, tile }: { icon: { driver: string } | { url: string }; tile?: 32 | 36 }) {
  const mark = "url" in icon
    ? <span style={{ backgroundImage: `url("${icon.url}")`, backgroundPosition: "50%", backgroundRepeat: "no-repeat", backgroundSize: "contain", height: 16, width: 16, flexShrink: 0 }} />
    : <ProviderGlyph driver={icon.driver} size={16} />;
  if (!tile) return <span style={{ display: "flex", flexShrink: 0, height: 16, width: 16, alignItems: "center", justifyContent: "center" }}>{mark}</span>;
  return <span style={{ alignItems: "center", backgroundColor: "#F3F3F3", borderRadius: 8, display: "flex", flexShrink: 0, height: tile, width: tile, justifyContent: "center" }}>{mark}</span>;
}

export function Section({ title, children, last, label }: { title: string; children: ReactNode; last?: boolean; label?: string }) {
  return (
    <section aria-label={label ?? title} style={{ ...(last ? {} : { borderBottom: `1px solid ${LINE}` }), display: "flex", flexDirection: "column", gap: 10, paddingBlock: 18 }}>
      <div style={{ ...text(12, FAINT, 600), letterSpacing: "0.02em", textTransform: "uppercase" }}>{title}</div>
      {children}
    </section>
  );
}

export function Row({ label, children, actions }: { label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 12 }}>
      <div style={{ ...text(13, MUTED), flexShrink: 0, width: 120 }}>{label}</div>
      <div style={{ flex: "1 1 0%", minWidth: 0, ...text(13) }}>{children}</div>
      {actions ? <div style={{ display: "flex", gap: 8 }}>{actions}</div> : null}
    </div>
  );
}

export function Chevron({ open }: { open?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }}>
      <path d="m9 18 6-6-6-6" fill="none" stroke={FAINT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Plus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12 5v14M5 12h14" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A text-like button: "Add another account", "Details", "Use another way to sign in". */
export function LinkButton({ children, onClick, disabled, title, expanded }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; expanded?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      style={{ all: "unset", boxSizing: "border-box", alignItems: "center", display: "flex", gap: 8, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}>
      {children}
    </button>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div role="alert" style={{ ...text(12, "#D83A3A") }}>{error}</div> : null;
}

