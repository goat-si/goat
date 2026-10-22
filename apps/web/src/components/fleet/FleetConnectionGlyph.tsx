import { cn } from "../../lib/utils";
import {
  fleetConnectionVisual,
  type FleetConnectionState,
  type FleetConnectionTone,
} from "./fleetConnection";

const STROKE: Record<FleetConnectionTone, string> = {
  success: "stroke-success",
  warning: "stroke-warning",
  destructive: "stroke-destructive",
  muted: "stroke-muted-foreground",
};

const FILL: Record<FleetConnectionTone, string> = {
  success: "fill-success",
  warning: "fill-warning",
  destructive: "fill-destructive",
  muted: "fill-muted-foreground",
};

/**
 * A connection state's mark, centered on the origin and about 10 units across.
 * Each state group has its own shape, so it reads without color.
 */
export function FleetConnectionGlyph(props: {
  readonly state: FleetConnectionState;
  /** Separates the mark from whatever it sits on. */
  readonly halo?: boolean;
}) {
  const { glyph, tone } = fleetConnectionVisual(props.state);
  if (glyph === null) return null;
  return (
    <g aria-hidden className="pointer-events-none">
      {props.halo ? <circle r={6.5} className="fill-background" /> : null}
      {glyph === "dot" ? <circle r={3.5} className={FILL[tone]} /> : null}
      {glyph === "ring" ? (
        // Dashed like the host's edge, and unlike the solid hollow "Reported" dot.
        <circle
          r={3.4}
          fill="none"
          strokeWidth={1.4}
          strokeDasharray="2.2 1.36"
          className={STROKE[tone]}
        />
      ) : null}
      {glyph === "arc" ? (
        // Three quarters of a ring: an attempt under way.
        <circle
          r={3.4}
          fill="none"
          strokeWidth={1.6}
          strokeDasharray="13 8.4"
          strokeLinecap="round"
          transform="rotate(-90)"
          className={STROKE[tone]}
        />
      ) : null}
      {glyph === "half" ? (
        <>
          <circle r={3.4} fill="none" strokeWidth={1.4} className={STROKE[tone]} />
          <path d="M0 -3.4 A3.4 3.4 0 0 0 0 3.4 Z" className={FILL[tone]} />
        </>
      ) : null}
      {glyph === "square" ? (
        // A stop mark: solid, where the away ring is dashed and hollow.
        <rect x={-3} y={-3} width={6} height={6} rx={1} className={FILL[tone]} />
      ) : null}
      {glyph === "alert" ? (
        <>
          <path
            d="M0 -4.6 L4.8 3.9 L-4.8 3.9 Z"
            strokeWidth={1}
            strokeLinejoin="round"
            className={cn(FILL[tone], STROKE[tone])}
          />
          <rect x={-0.6} y={-1.9} width={1.2} height={3.2} rx={0.5} className="fill-background" />
          <circle cy={2.6} r={0.65} className="fill-background" />
        </>
      ) : null}
    </g>
  );
}

/** The glyph as a standalone inline icon, for the legend. */
export function FleetConnectionIcon(props: { readonly state: FleetConnectionState }) {
  return (
    <svg aria-hidden viewBox="-5 -5 10 10" className="size-3 shrink-0 overflow-visible">
      <FleetConnectionGlyph state={props.state} />
    </svg>
  );
}
