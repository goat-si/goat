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
type Answer = { key: string; value?: BotWorkResult; error?: LookupError };
type Read = { key: string; generation: number };

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
  const generation = useRef(0);
  const runningRef = useRef<Read | null>(null);
  const [running, setRunning] = useState<Read | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [staleKey, setStaleKey] = useState<string | null>(null);
  if (staleKey !== null && staleKey !== key) setStaleKey(null);
  const listed = list.established && list.holdsTask;
  if (answer !== null && (answer.key !== key || !readable || listed)) setAnswer(null);
  const held = answer?.key === key;
  const inFlight = running?.key === key;
  const decision = botTaskLookupDecision({
    readable,
    ...list,
    held,
    stale: staleKey === key,
    inFlight,
  });
  const settle = useStableCallback((read: Read, next: Answer) => {
    if (runningRef.current === read) {
      runningRef.current = null;
      setRunning(null);
    }
    if (read.generation === generation.current && read.key === key) setAnswer(next);
  });
  const start = useStableCallback(() => {
    if (runningRef.current?.key === key) return;
    const read = { key, generation: ++generation.current };
    runningRef.current = read;
    setRunning(read);
    setStaleKey(null);
    void command({ environmentId, input: { taskId, botId } }).then((result) =>
      settle(
        read,
        result._tag === "Success"
          ? { key: read.key, value: result.value }
          : { key: read.key, error: failureKind(squashAtomCommandFailure(result)) },
      ),
    );
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Starts the read botTaskLookupDecision asks for.
  useEffect(() => {
    if (decision.startRead) start();
  }, [decision.startRead, start]);
  return {
    supported,
    permitted,
    view: decision.view,
    value: held ? answer.value : undefined,
    error: held && !inFlight ? answer.error : undefined,
    loading: inFlight || (decision.view === "waiting" && readable),
    /** The person's Try again; the only read that ignores a held answer. */
    retry: () => {
      if (decision.canRetry) start();
    },
    /** An action on the task completed, so its view is reread once the list settles. */
    invalidate: (task: ChannelTaskId = taskId) =>
      setStaleKey(JSON.stringify([environmentId, botId, task])),
  };
}
