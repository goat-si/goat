import type { EnvironmentId } from "@goat/contracts";
import { offlineSnapshotAgeLabel } from "@goat/client-runtime/connection";
import { shellSyncMessage } from "@goat/client-runtime/state/presentation";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironment } from "../../state/environments";
import {
  useEnvironmentConnectionPhase,
  useEnvironmentConnectionUnreachable,
  useEnvironmentShellSync,
  useEnvironmentSnapshotCapturedAt,
} from "../../state/presentation";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentConnectionProgressLabel } from "../EnvironmentConnectionProgress";

/**
 * A still dot beside a remote thread's machine glyph while its environment is
 * not connected or its shell data is not current. The row
 * hover card says what the connection is doing.
 */
export function SidebarEnvironmentConnectionDot({
  environmentId,
}: {
  environmentId: EnvironmentId;
}) {
  const phase = useEnvironmentConnectionPhase(environmentId);
  const unreachable = useEnvironmentConnectionUnreachable(environmentId);
  const syncMessage = shellSyncMessage(useEnvironmentShellSync(environmentId));
  if (phase === null || (phase === "connected" && syncMessage === null)) return null;
  return (
    <span
      aria-label={phase === "connected" ? (syncMessage ?? undefined) : undefined}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        connectionPhaseDotClassName(phase === "connected" ? "reconnecting" : phase, unreachable),
      )}
    />
  );
}

/** The row hover card reports transport progress or a shell synchronization warning. */
export function SidebarEnvironmentConnectionStatus({
  environmentId,
}: {
  environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const syncMessage = shellSyncMessage(useEnvironmentShellSync(environmentId));
  const capturedAt = useEnvironmentSnapshotCapturedAt(environmentId);
  const nowMinute = useNowMinute();
  if (
    environment === null ||
    (environment.connection.phase === "connected" && syncMessage === null)
  )
    return null;
  const age =
    environment.connection.phase === "connected"
      ? null
      : offlineSnapshotAgeLabel(capturedAt, Date.parse(`${nowMinute}:59.999Z`));
  return (
    <span className="shrink-0">
      ·{" "}
      {environment.connection.phase === "connected" ? (
        syncMessage
      ) : (
        <>
          <EnvironmentConnectionProgressLabel connection={environment.connection} />
          {age === null ? null : ` · ${age}`}
        </>
      )}
    </span>
  );
}
