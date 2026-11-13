import { useAtomValue } from "@effect/atom-react";
import { BotId, type EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { Badge } from "../ui/badge";

const NO_WORK = Atom.make(null);

export function GoatBotRowSignals({
  environmentId,
  botId,
  waiting,
  waitingState,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  readonly waiting: number | undefined;
  readonly waitingState: "ready" | "pending" | "unavailable";
}) {
  const environment = useEnvironment(environmentId);
  const work = useAtomValue(
    environmentId === null
      ? NO_WORK
      : channelEnvironment.homeCurrentOpenableWorkAtom([environmentId, botId]),
  );
  const capabilities = environment?.serverConfig?.environment.capabilities;
  const h2 =
    capabilities?.goatBotTaskThreadsPaged === true && capabilities.goatBotTaskLookupSearch === true;
  const available =
    environment?.connection.phase === "connected" &&
    work?.eligible === true &&
    work.list === "ready";
  const unread = available
    ? [...work.work.running, ...work.work.waiting, ...work.work.finished].filter(
        (item) => item.row.unread,
      ).length
    : undefined;
  const missing = [
    unread === undefined &&
    (environment?.connection.phase !== "connected" || !work?.eligible || work.list === "failed")
      ? "Unread"
      : null,
    waiting === undefined &&
    (environment?.connection.phase !== "connected" || waitingState === "unavailable")
      ? "waiting"
      : null,
  ].filter(Boolean);
  const label = `${unread} unread task${unread === 1 ? "" : "s"}; recent work only; older work may be missing`;
  if (!h2) return null;
  return (
    <>
      {unread !== undefined && unread > 0 ? (
        <Badge size="sm" variant="secondary" aria-label={label} title={label}>
          {unread}
        </Badge>
      ) : null}
      {missing.length > 0 ? (
        <Badge
          size="sm"
          variant="outline"
          aria-label={`${missing.join(" and ")} unavailable`}
          title={`${missing.join(" and ")} unavailable`}
        >
          –
        </Badge>
      ) : null}
    </>
  );
}
