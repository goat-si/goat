import type { EnvironmentId } from "@goat/contracts";

import { cn } from "~/lib/utils";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentConnectionPhase } from "../../state/presentation";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { EnvironmentConnectionProgressLabel } from "../EnvironmentConnectionProgress";

/**
 * A still dot beside a remote thread's machine glyph while its environment is
 * not connected, in the same colors as every other connection dot. The row
 * hover card says what the connection is doing.
 */
export function SidebarEnvironmentConnectionDot({
  environmentId,
}: {
  environmentId: EnvironmentId;
}) {
  const phase = useEnvironmentConnectionPhase(environmentId);
  if (phase === null || phase === "connected") return null;
  return (
    <span className={cn("size-1.5 shrink-0 rounded-full", connectionPhaseDotClassName(phase))} />
  );
}

/** The thread view's connection label, for the row hover card; null when connected. */
export function SidebarEnvironmentConnectionStatus({
  environmentId,
}: {
  environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  if (environment === null || environment.connection.phase === "connected") return null;
  return (
    <span className="shrink-0">
      · <EnvironmentConnectionProgressLabel connection={environment.connection} />
    </span>
  );
}
