// GOAT 2: one entry point that draws the real provider mark for a driver kind.
// Mirrors goat apps/web/src/components/chat/ProviderInstanceIcon.tsx (PROVIDER_ICON_BY_PROVIDER for
// codex/claudeAgent/antigravity, provider client `icon` defs for the rest).
import { useId, type CSSProperties } from "react";
import { AntigravityIcon, ClaudeAI, OpenAI } from "./Icons.tsx";
import {
  cursorIcon,
  devinCloudIcon,
  fxIcon,
  grokIcon,
  museIcon,
  omoIcon,
  opencodeIcon,
  piIcon,
  type ProviderIcon,
} from "./providerIconDefs.ts";

const DEF_BY_DRIVER: Record<string, ProviderIcon> = {
  pi: piIcon,
  opencode: opencodeIcon,
  grok: grokIcon,
  muse: museIcon,
  cursor: cursorIcon,
  cursorCloud: cursorIcon,
  fx: fxIcon,
  omo: omoIcon,
  devinCloud: devinCloudIcon,
};

function DefIcon(props: { def: ProviderIcon; size: number; dark: boolean }) {
  const gid = useId();
  const { def, size, dark } = props;
  return (
    <svg width={size} height={size} viewBox={def.viewBox} aria-hidden="true">
      {def.paths.map((path, index) => {
        const gradientId = `${gid}-g${index}`;
        const fill = path.gradient
          ? `url(#${gradientId})`
          : (dark ? path.fill?.dark : path.fill?.light) ?? (dark ? def.fill.dark : def.fill.light);
        return (
          <g key={index}>
            {path.gradient ? (
              <defs>
                <linearGradient
                  id={gradientId}
                  gradientUnits="userSpaceOnUse"
                  x1={path.gradient.x1}
                  y1={path.gradient.y1}
                  x2={path.gradient.x2}
                  y2={path.gradient.y2}
                >
                  {path.gradient.stops.map((stop) => (
                    <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </linearGradient>
              </defs>
            ) : null}
            <path d={path.d} fill={fill} fillRule={path.fillRule} />
          </g>
        );
      })}
    </svg>
  );
}

export function ProviderGlyph(props: {
  driver: string;
  size?: number;
  dark?: boolean;
  style?: CSSProperties;
}) {
  const size = props.size ?? 12;
  const dark = props.dark ?? false;
  switch (props.driver) {
    case "codex":
      return <OpenAI width={size} height={size} fill={dark ? "#fff" : "#000"} aria-hidden="true" />;
    case "claudeAgent":
    case "claude":
    case "claudeCloud":
      return <ClaudeAI width={size} height={size} fill="#d97757" aria-hidden="true" />;
    case "antigravity":
      return <AntigravityIcon width={size} height={size} aria-hidden="true" />;
    default: {
      const def = DEF_BY_DRIVER[props.driver];
      if (def) return <DefIcon def={def} size={size} dark={dark} />;
      // Unknown driver: initials, like goat's providerInstanceInitials fallback.
      return (
        <span style={{ fontSize: size * 0.7, fontWeight: 600, lineHeight: 1 }}>
          {props.driver.slice(0, 2).toUpperCase()}
        </span>
      );
    }
  }
}
