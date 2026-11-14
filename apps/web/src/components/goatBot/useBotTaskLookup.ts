import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotId, BotWorkResult, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { botTaskLookupDecision } from "./botTaskLookupDecision";

type LookupError = "missing" | "failed" | "denied";
type Answer = { period: number; value?: BotWorkResult; error?: LookupError };

function failureKind(error: unknown): LookupError {
  if (!error || typeof error !== "object") return "failed";
  if ("reason" in error && error.reason === "not_found") return "missing";
  return ("_tag" in error && error._tag === "EnvironmentAuthorizationError") ||
    ("reason" in error && error.reason === "forbidden")
    ? "denied"
    : "failed";
}

/** Reads a task the bot's current list does not hold; botTaskLookupDecision says when. */
export function useBotTaskLookup(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  botId: BotId,
  list: {
    readonly established: boolean;
    readonly refreshing: boolean;
    readonly holdsTask: boolean;
  },
  available: boolean,
) {
  const configs = useServerConfigs();
  const supported =
    configs.get(environmentId)?.environment.capabilities.goatBotTaskLookupSearch === true;
  const permitted = useAtomValue(channelEnvironment.getBotTask.permissionAtom(environmentId));
  const command = useAtomCommand(channelEnvironment.getBotTask, { reportFailure: false });
  const readable = supported && permitted && available;
  const key = JSON.stringify([environmentId, botId, taskId]);
  // A read, its answer and an action's invalidation belong to one period in which this task is the
  // pane's and eligible. A new period begins when either changes; this is lifecycle, not a decision.
  const periodKey = readable && list.established && !list.holdsTask ? key : null;
  const [period, setPeriod] = useState({ key: periodKey, id: 0 });
  if (period.key !== periodKey) setPeriod({ key: periodKey, id: period.id + 1 });
  /** The mounted period; a read whose period is no longer live sets nothing. */
  const live = useRef<number | null>(null);
  /** The running read's period, for two presses that arrive before React renders again. */
  const runningRef = useRef<number | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [stale, setStale] = useState<number | null>(null);
  const held = answer?.period === period.id;
  const inFlight = running === period.id;
  const decision = botTaskLookupDecision({
    readable,
    ...list,
    held,
    stale: stale === period.id,
    inFlight,
  });
  const start = useStableCallback((id: number) => {
    if (live.current !== id || runningRef.current === id) return;
    runningRef.current = id;
    setRunning(id);
    setStale(null);
    void command({ environmentId, input: { taskId, botId } }).then((result) => {
      if (live.current !== id) return;
      runningRef.current = null;
      setRunning(null);
      setAnswer(
        result._tag === "Success"
          ? { period: id, value: result.value }
          : { period: id, error: failureKind(squashAtomCommandFailure(result)) },
      );
    });
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Marks the period live while it is mounted.
  useEffect(() => {
    live.current = period.id;
    return () => {
      live.current = null;
    };
  }, [period.id]);
  // oxlint-disable-next-line goat/react-effect-budget -- Starts the read botTaskLookupDecision asks for.
  useEffect(() => {
    if (decision.startRead) start(period.id);
  }, [decision.startRead, period.id, start]);
  /**
   * An action or acknowledgement sent for `sent` (this hook's key then) completed. It marks the
   * view to reread only while that is still the mounted pane's task; false means drop it.
   */
  const complete = useStableCallback((sent: string) => {
    if (sent !== key || live.current === null) return false;
    setStale(period.id);
    return true;
  });
  return {
    key,
    supported,
    permitted,
    view: decision.view,
    value: held ? answer.value : undefined,
    error: held && !inFlight ? answer.error : undefined,
    loading: inFlight || (decision.view === "waiting" && readable),
    /** The person's Try again; the only read that ignores a held answer. */
    retry: () => {
      if (decision.canRetry) start(period.id);
    },
    complete,
  };
}
