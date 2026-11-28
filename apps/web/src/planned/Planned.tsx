// Shell for a surface that is not built yet (structure/60_planned.md): real layout from the board,
// control disabled, a small "Planned" tag and a one-line tooltip. No fake data behind it.
import type { El } from "../paper/parts.tsx";
import { PLANNED, plannedTooltip, type PlannedId } from "./registry.ts";

/** Props for a board control that is a shell: disabled, described, does nothing. */
export function plannedProps(id: PlannedId): El {
  return {
    "aria-disabled": true,
    "aria-label": plannedTooltip(id),
    title: plannedTooltip(id),
    "data-planned": id,
    onClick: (e) => e.preventDefault(),
  };
}

export function Planned({ id, style }: { id: PlannedId; style?: React.CSSProperties }) {
  return (
    <span title={plannedTooltip(id)} data-planned-tag={id} aria-label={`Planned: ${plannedTooltip(id)}`}
      style={{ display: "inline-flex", alignItems: "center", height: 16, paddingInline: 5, borderRadius: 4, background: "#F3F3F3", color: "#8F8F8F", fontFamily: '"SF Pro", system-ui, sans-serif', fontSize: 10.5, lineHeight: "16px", fontWeight: 500, letterSpacing: 0.1, whiteSpace: "nowrap", cursor: "default", ...style }}>
      {PLANNED[id].state === "undecided" ? "Undecided" : "Planned"}
    </span>
  );
}
