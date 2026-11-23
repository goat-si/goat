import type {
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@goat/contracts";
import { remainingPercent } from "@goat/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { resolveThreadDetailsLimits } from "./ThreadDetailsUsage.logic";

export function ThreadDetailsLimits({
  providerInstanceId,
  model,
  providers,
  sources,
}: {
  providerInstanceId: ProviderInstanceId | null;
  model: string | null;
  providers: readonly ServerProvider[];
  sources: UsageLimitSourceSnapshots;
}) {
  const gt = useGT();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  if (!resolved) return null;
  const windows =
    resolved.kind === "pool"
      ? resolved.windows.map((window) => ({
          id: window.id,
          label: window.label,
          remaining: window.remainingPercent,
        }))
      : resolved.limits.windows.map((window) => ({
          id: window.id,
          label: window.label,
          remaining: remainingPercent(window),
        }));
  if (!windows.length) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <Link
        to="/usage"
        className="flex flex-col gap-1 rounded-lg px-2.5 py-1 text-xs hover:bg-muted"
      >
        {windows.map((window) => (
          <span key={window.id} className="flex justify-between gap-2">
            <span>{window.label}</span>
            <span>{window.remaining}% left</span>
          </span>
        ))}
      </Link>
    </ThreadDetailsSection>
  );
}
