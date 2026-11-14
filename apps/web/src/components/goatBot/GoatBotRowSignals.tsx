import { useAtomValue } from "@effect/atom-react";
import type { BotId, EnvironmentId } from "@goat/contracts";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { Badge } from "../ui/badge";

type Props = {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  /** Whether Home governs this environment; otherwise the row is the older one, with no signals. */
  readonly governed: boolean;
  readonly waiting: number | undefined;
  readonly waitingState: "ready" | "pending" | "unavailable";
};

/** A row Home does not govern subscribes to nothing of its bot's work. */
export function GoatBotRowSignals(props: Props) {
  return props.governed && props.environmentId !== null ? (
    <GovernedRowSignals {...props} environmentId={props.environmentId} />
  ) : null;
}

function GovernedRowSignals({
  environmentId,
  botId,
  waiting,
  waitingState,
}: Props & { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const signal = useAtomValue(channelEnvironment.homeCurrentUnreadAtom([environmentId, botId]));
  const unread = typeof signal === "number" ? signal : undefined;
  const missing = [
    signal === "unavailable" ? "Unread" : null,
    waiting === undefined &&
    (environment?.connection.phase !== "connected" || waitingState === "unavailable")
      ? "waiting"
      : null,
  ].filter(Boolean);
  const label = `${unread} unread task${unread === 1 ? "" : "s"}; recent work only; older work may be missing`;
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
