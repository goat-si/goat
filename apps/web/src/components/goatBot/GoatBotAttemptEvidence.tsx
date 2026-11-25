import type { botTaskAttemptEvidence } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useGT } from "gt-react";
import { useEnvironment } from "~/state/environments";

function MachineName({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  return environment?.serverConfig?.environment.label || environment?.label || environmentId;
}

export function GoatBotAttemptEvidence({
  evidence,
}: {
  evidence: NonNullable<ReturnType<typeof botTaskAttemptEvidence>>;
}) {
  const gt = useGT();
  const { worker, summary, report } = evidence;
  if (!worker && !summary && !report) return null;
  return (
    <div className="space-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
      {worker && (
        <p className="break-words">
          <strong className="font-medium text-foreground">{gt("Worker machine")}</strong>{" "}
          {worker.host ?? <MachineName environmentId={worker.environmentId} />}
        </p>
      )}
      {summary && (
        <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">
          <strong className="font-medium text-foreground">{gt("Latest update")}</strong>{" "}
          <span>{summary}</span>
        </p>
      )}
      {report && (
        <p>{report === "present" ? gt("Worker report received") : gt("Worker report missing")}</p>
      )}
    </div>
  );
}
