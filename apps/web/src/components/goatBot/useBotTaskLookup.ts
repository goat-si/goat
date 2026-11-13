import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { BotId, type BotWorkResult, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

type Lookup = {
  key: string;
  value?: BotWorkResult;
  error?: "missing" | "failed" | "denied";
  loading?: boolean;
};

export function useBotTaskLookup(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  botId: BotId,
  needed: boolean,
  paused = false,
) {
  const configs = useServerConfigs();
  const supported =
    configs.get(environmentId)?.environment.capabilities.goatBotTaskLookupSearch === true;
  const permitted = useAtomValue(channelEnvironment.getBotTask.permissionAtom(environmentId));
  const read = useAtomCommand(channelEnvironment.getBotTask, { reportFailure: false });
  const sequence = useRef(0);
  const inFlight = useRef<string | null>(null);
  const [answer, setAnswer] = useState<Lookup | null>(null);
  const key = JSON.stringify([environmentId, botId, taskId]);
  const eligibleKey = supported && permitted && needed ? key : null;
  const [previousKey, setPreviousKey] = useState(eligibleKey);
  if (eligibleKey !== previousKey) {
    setPreviousKey(eligibleKey);
    setAnswer(null);
  }
  const run = useStableCallback(
    (
      environmentId: EnvironmentId,
      taskId: ChannelTaskId,
      botId: BotId,
      needed: boolean,
      supported: boolean,
      permitted: boolean,
      force = false,
    ) => {
      if (!supported || !permitted || !needed || (!force && inFlight.current === key)) return;
      inFlight.current = key;
      const current = ++sequence.current;
      setAnswer((previous) => ({
        key,
        ...(previous?.key === key && previous.value ? { value: previous.value } : {}),
        loading: true,
      }));
      void read({ environmentId, input: { taskId, botId } }).then((result) => {
        if (inFlight.current === key) inFlight.current = null;
        if (current !== sequence.current) return;
        if (result._tag === "Success") setAnswer({ key, value: result.value });
        else {
          const error = squashAtomCommandFailure(result);
          setAnswer({
            key,
            error:
              error &&
              typeof error === "object" &&
              "reason" in error &&
              error.reason === "not_found"
                ? "missing"
                : error &&
                    typeof error === "object" &&
                    (("_tag" in error && error._tag === "EnvironmentAuthorizationError") ||
                      ("reason" in error && error.reason === "forbidden"))
                  ? "denied"
                  : "failed",
          });
        }
      });
    },
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Reads the selected task and invalidates in-flight reads when its identity changes.
  useEffect(() => {
    run(environmentId, taskId, botId, needed, supported, permitted);
    return () => {
      sequence.current++;
      inFlight.current = null;
    };
  }, [environmentId, botId, taskId, needed, supported, permitted, run]);
  const reload = useStableCallback((force = false) => {
    if (!paused) run(environmentId, taskId, botId, needed, supported, permitted, force);
  });
  return {
    supported,
    permitted,
    value: supported && permitted && needed && answer?.key === key ? answer.value : undefined,
    error: supported && permitted && needed && answer?.key === key ? answer.error : undefined,
    loading: eligibleKey !== null && (answer?.key !== key || answer.loading === true),
    reload,
  };
}
