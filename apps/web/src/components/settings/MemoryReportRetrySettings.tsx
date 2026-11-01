import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MemorySpaceId, MemoryReportDelivery } from "@goat/contracts";
import {
  isMemoryReportRetryCandidate,
  presentMemoryReport,
  presentMemoryReportReset,
} from "@goat/client-runtime/memory-presentation";
import { useContext, useEffect, useRef, useState } from "react";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryReportRetryIntent } from "./MemorySettings.logic";
import { Button } from "../ui/button";

/** The server decides ownership, active claims and final reset eligibility. */
function MemoryReportRetryRequest({
  environmentId,
  memorySpaceId,
  reports,
  onSettled,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  reports: readonly MemoryReportDelivery[];
  onSettled: () => void;
}) {
  const registry = useContext(RegistryContext);
  const allowed = useAtomValue(memoryEnvironment.resetReportAttempts.permissionAtom(environmentId));
  const reset = useAtomCommand(memoryEnvironment.resetReportAttempts, { reportFailure: false });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = reports.filter((report) =>
    isMemoryReportRetryCandidate(report, environmentId),
  );
  const selectedReports = candidates
    .filter((report) => selected.includes(report.reportId))
    .slice(0, 32);
  return (
    <div className="space-y-3" role="group" aria-label="Report delivery retry">
      <p className="text-xs leading-normal text-muted-foreground/80">
        Choose up to 32 exhausted failed reports. Retry resets automatic delivery attempts; it does
        not release storage or start an agent.
      </p>
      {reports.map((report, index) => (
        <label key={report.reportId} className="block space-x-2">
          <input
            type="checkbox"
            aria-label={`Retry report ${index + 1}`}
            checked={
              allowed && selectedReports.some((candidate) => candidate.reportId === report.reportId)
            }
            disabled={
              !allowed ||
              busy ||
              !candidates.includes(report) ||
              (selectedReports.length === 32 && !selected.includes(report.reportId))
            }
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setSelected((current) =>
                checked
                  ? [...current, report.reportId]
                  : current.filter((id) => id !== report.reportId),
              );
            }}
          />
          <span>
            Report {index + 1} · Automatic attempts:{" "}
            {presentMemoryReport(report).automaticAttempts ?? "Unknown"}
          </span>
        </label>
      ))}
      {!allowed ? (
        <p className="text-xs leading-normal text-muted-foreground/80">
          Settings write permission is required to retry reports.
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={!allowed || busy || selectedReports.length === 0}
        onClick={() => {
          if (
            busy ||
            !registry.get(memoryEnvironment.resetReportAttempts.permissionAtom(environmentId))
          )
            return;
          const input = memoryReportRetryIntent(environmentId, memorySpaceId, reports, selected);
          if (!input) return;
          setBusy(true);
          setMessage(null);
          void reset({
            environmentId,
            input,
          }).then((result) => {
            if (
              !mounted.current ||
              !registry.get(memoryEnvironment.resetReportAttempts.permissionAtom(environmentId))
            )
              return;
            setBusy(false);
            setSelected([]);
            setMessage(
              result._tag === "Success"
                ? presentMemoryReportReset(result.value).label
                : "Report retry denied or unavailable. Reload reports before trying again.",
            );
            onSettled();
          });
        }}
      >
        Retry selected reports
      </Button>
      {message ? (
        <p className="text-xs leading-normal text-muted-foreground/80" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Regrant starts a new selection; an old settlement cannot update it. */
export function MemoryReportRetrySettings(props: Parameters<typeof MemoryReportRetryRequest>[0]) {
  const allowed = useAtomValue(
    memoryEnvironment.resetReportAttempts.permissionAtom(props.environmentId),
  );
  return <MemoryReportRetryRequest key={String(allowed)} {...props} />;
}
