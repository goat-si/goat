const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const UNIT_WORDS = { m: "minute", h: "hour", d: "day" } as const;

/**
 * A work row's last activity: compact for sight ("now", "5m", "2h", "3d") and in words for a
 * screen reader ("just now", "5 minutes ago"). The compact scale must stay equal to web's
 * formatRelativeElapsed (apps/web/src/timestampFormat.test.ts pins it) and to mobile's row time.
 */
export function goatBotRowTime(
  timestamp: string,
  nowMs: number,
): { readonly text: string; readonly spoken: string } | null {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return null;
  const elapsedMs = Math.max(0, nowMs - at);
  if (elapsedMs < MINUTE_MS) return { text: "now", spoken: "just now" };
  const [count, unit] =
    elapsedMs < HOUR_MS
      ? [Math.floor(elapsedMs / MINUTE_MS), "m" as const]
      : elapsedMs < DAY_MS
        ? [Math.floor(elapsedMs / HOUR_MS), "h" as const]
        : [Math.floor(elapsedMs / DAY_MS), "d" as const];
  return {
    text: `${count}${unit}`,
    spoken: `${count} ${UNIT_WORDS[unit]}${count === 1 ? "" : "s"} ago`,
  };
}
