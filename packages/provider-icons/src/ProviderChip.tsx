// GOAT 2: the provider badge that sits on a bot avatar's bottom-right corner.
// `working` draws a spinning ring around the chip (the bot is running a turn).
import type { ReactNode } from "react";
import { ProviderGlyph } from "./ProviderGlyph.tsx";

const SPIN_KEYFRAMES = "@keyframes goat2-chip-spin{to{transform:rotate(360deg)}}";

export function ProviderChip(props: {
  driver: string;
  working?: boolean;
  /** Matches the surface behind the avatar so the chip looks cut out. */
  ringColor?: string;
  size?: number;
}) {
  const size = props.size ?? 16;
  const ring = props.ringColor ?? "#F7F7F8";
  return (
    <span
      title={props.driver}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: size,
        height: size,
        borderRadius: 9999,
        // Knockout: the chip takes the surface color, so it reads as transparent but still separates
        // the mark from the avatar body (non-text contrast, WCAG 1.4.11).
        background: ring,
        boxShadow: `0 0 0 2px ${ring}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ProviderGlyph driver={props.driver} size={Math.round(size * 0.65)} />
      {props.working ? (
        <>
          <style>{SPIN_KEYFRAMES}</style>
          <svg
            aria-label="Working"
            width={size + 8}
            height={size + 8}
            viewBox="0 0 28 28"
            style={{
              position: "absolute",
              left: -4,
              top: -4,
              animation: "goat2-chip-spin 1.2s linear infinite",
            }}
          >
            <circle
              cx="14"
              cy="14"
              r="12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeDasharray="22 57"
            />
          </svg>
        </>
      ) : null}
    </span>
  );
}

export function AvatarWithChip(props: {
  children: ReactNode;
  driver: string;
  working?: boolean;
  needsYou?: boolean;
  ringColor?: string;
}) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 40, height: 40, flexShrink: 0 }}>
      {props.children}
      {props.needsYou ? (
        <span
          aria-label="Needs you"
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 10,
            height: 10,
            borderRadius: 9999,
            background: "#E5484D",
            boxShadow: `0 0 0 2px ${props.ringColor ?? "#F7F7F8"}`,
          }}
        />
      ) : null}
      <ProviderChip driver={props.driver} working={props.working ?? false} ringColor={props.ringColor ?? "#F7F7F8"} />
    </span>
  );
}
