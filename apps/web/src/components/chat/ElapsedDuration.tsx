import { formatDuration } from "@goat/shared/orchestrationTiming";
import { tickTextContent } from "~/lib/tickTextContent";

export function ElapsedDuration({
  startedAt,
  endedAt,
  live,
  className,
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
  className: string;
}) {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : null;
  if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) return null;
  return (
    <span
      className={className}
      ref={tickTextContent(
        (nowMs) => formatDuration(Math.max(0, (end ?? nowMs) - start)),
        live && end === null,
      )}
    />
  );
}
