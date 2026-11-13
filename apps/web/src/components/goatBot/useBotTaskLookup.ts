import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { BotId, type BotWorkResult, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

type Lookup = { key: string; value?: BotWorkResult; error?: "missing" | "failed" };

export function useBotTaskLookup(
  environmentId: EnvironmentId,
  taskId: ChannelTaskId,
  botId: BotId,
  needed: boolean,
) {
  const configs = useServerConfigs();
  const supported =
    configs.get(environmentId)?.environment.capabilities.goatBotTaskLookupSearch === true;
  const permitted = useAtomValue(channelEnvironment.getBotTask.permissionAtom(environmentId));
  const read = useAtomCommand(channelEnvironment.getBotTask, { reportFailure: false });
  const sequence = useRef(0);
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
    ) => {
      if (!supported || !permitted || !needed) return;
      const current = ++sequence.current;
      void read({ environmentId, input: { taskId, botId } }).then((result) => {
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
    };
  }, [environmentId, botId, taskId, needed, supported, permitted, run]);
  const reload = () => run(environmentId, taskId, botId, needed, supported, permitted);
  return {
    supported,
    permitted,
    value: supported && permitted && needed && answer?.key === key ? answer.value : undefined,
    error: supported && permitted && needed && answer?.key === key ? answer.error : undefined,
    reload,
  };
}
