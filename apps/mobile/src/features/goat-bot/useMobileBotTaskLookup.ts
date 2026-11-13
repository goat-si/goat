import { useAtomValue } from "@effect/atom-react";
import { groupBotWork, type BotWorkTask } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  BotWorkResult,
  ChannelChildWorkGroup,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_PERMISSION = Atom.make(false);

type Unavailable = Extract<BotWorkResult["task"], { readonly state: "unavailable" }>;

/** What a task's own screen knows about a task its bot's current list does not hold. */
export type MobileTaskLookup =
  /** Not asked: the list holds the task, the server cannot look it up, or it is offline. */
  | { readonly state: "off" }
  | { readonly state: "denied" }
  | { readonly state: "loading" }
  | { readonly state: "missing" }
  | { readonly state: "failed"; readonly reload: () => void }
  | {
      readonly state: "known";
      readonly task: BotWorkTask;
      readonly result: BotWorkResult;
      readonly reload: () => void;
    }
  | {
      readonly state: "unavailable";
      readonly task: Unavailable;
      readonly result: BotWorkResult;
      readonly reload: () => void;
    };

type Answer = { readonly key: string; readonly value?: BotWorkResult; readonly missing?: boolean };

/**
 * Reads one task of one bot by id on request (`channel.getBotTask`), for a task screen whose
 * task the current list does not hold. Each read answers only the task it was sent for, and a
 * later read replaces an earlier one; nothing is kept between screens.
 */
export function useMobileBotTaskLookup(input: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  readonly taskId: ChannelTaskId | null;
  /** The current list settled without the task and the computer is connected. */
  readonly needed: boolean;
  readonly supported: boolean;
  /** Child work read for this task, for its subagents. */
  readonly childGroups: ReadonlyArray<ChannelChildWorkGroup>;
}): MobileTaskLookup {
  const { environmentId, botId, taskId, supported } = input;
  const permitted = useAtomValue(
    environmentId === null || !supported
      ? NO_PERMISSION
      : channelEnvironment.getBotTask.permissionAtom(environmentId),
  );
  const asking =
    input.needed && supported && permitted && environmentId !== null && taskId !== null;
  const key = JSON.stringify([environmentId, botId, taskId]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const sequence = useRef(0);
  const read = (environmentId: EnvironmentId, botId: BotId, taskId: ChannelTaskId) => {
    const key = JSON.stringify([environmentId, botId, taskId]);
    const sent = ++sequence.current;
    void runAtomCommand(
      appAtomRegistry,
      channelEnvironment.getBotTask,
      { environmentId, input: { taskId, botId } },
      { label: "GOAT Bot task lookup", reportFailure: false },
    ).then((result) => {
      if (sent !== sequence.current) return;
      if (result._tag === "Success") {
        setFailedKey(null);
        setAnswer({ key, value: result.value });
        return;
      }
      const error = squashAtomCommandFailure(result);
      const missing =
        typeof error === "object" && error !== null && "reason" in error
          ? error.reason === "not_found"
          : false;
      if (missing) setAnswer({ key, missing: true });
      else setFailedKey(key);
    });
  };
  const readShown = useEffectEvent(read);
  // oxlint-disable-next-line goat/react-effect-budget -- Reads the shown task from the server and drops a read that a newer one replaced.
  useEffect(() => {
    if (!asking || environmentId === null || taskId === null) return;
    readShown(environmentId, botId, taskId);
    return () => {
      sequence.current++;
    };
  }, [asking, environmentId, botId, taskId]);
  if (!input.needed || !supported || environmentId === null || taskId === null)
    return { state: "off" };
  if (!permitted) return { state: "denied" };
  const reload = () => {
    setFailedKey(null);
    read(environmentId, botId, taskId);
  };
  if (failedKey === key) return { state: "failed", reload };
  if (answer?.key !== key) return { state: "loading" };
  if (answer.missing || answer.value === undefined) return { state: "missing" };
  const result = answer.value;
  if (result.task.state === "unavailable")
    return { state: "unavailable", task: result.task, result, reload };
  const work = groupBotWork(
    [result.task.row, ...result.codingRows],
    input.childGroups,
    environmentId,
    result.remoteWork,
  );
  const task = [...work.inProgress, ...work.done][0];
  return task === undefined ? { state: "missing" } : { state: "known", task, result, reload };
}
