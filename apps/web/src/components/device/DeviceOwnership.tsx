import type { DeviceServiceState, DeviceSummary, EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { useQuietThreadShell } from "~/state/entities";

const matches = (
  entry: { readonly hostId: string; readonly deviceId: string; readonly deviceName?: string },
  device: Pick<DeviceSummary, "hostId" | "id" | "name">,
) =>
  entry.hostId === device.hostId &&
  (entry.deviceId === device.id || entry.deviceName === device.name);

/** Who started a running device and which other threads have it open, so leftovers have an owner. */
export function DeviceOwnership(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly state: Pick<DeviceServiceState, "bootedBy" | "sessions">;
  readonly device: Pick<DeviceSummary, "hostId" | "id" | "name" | "booted">;
}) {
  if (!props.device.booted) return null;
  const starter = props.state.bootedBy?.find((entry) => matches(entry, props.device));
  const holders = [
    ...new Set(
      props.state.sessions
        .filter((session) => matches(session, props.device) && session.threadId !== props.threadId)
        .map((session) => session.threadId),
    ),
  ].filter((threadId) => threadId !== starter?.threadId);
  if (starter === undefined && holders.length === 0) return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {starter === undefined ? null : starter.threadId === props.threadId ? (
        "Started by this thread"
      ) : (
        <>
          Started by <ThreadName environmentId={props.environmentId} threadId={starter.threadId} />
        </>
      )}
      {holders.map((threadId, index) => (
        <span key={threadId}>
          {index === 0 ? (starter === undefined ? "Open in " : " · open in ") : ", "}
          <ThreadName environmentId={props.environmentId} threadId={threadId} />
        </span>
      ))}
    </span>
  );
}

function ThreadName(props: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) {
  const shell = useQuietThreadShell(props);
  const finished =
    shell !== null && (shell.settledOverride === "settled" || shell.archivedAt !== null);
  return (
    <>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: props.environmentId, threadId: props.threadId }}
        className="underline underline-offset-2"
      >
        {shell?.title?.trim() || "another thread"}
      </Link>
      {finished ? " (finished)" : ""}
    </>
  );
}
