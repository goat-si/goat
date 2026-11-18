import type { BotId, GoatBotEventSubject, ThreadId } from "@goat/contracts";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { pickMobileGoatBotHomeEnvironment } from "./goatBotHomeMode";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

/** What the bot's home should show when it opens from an event line. */
export interface MobileBotHomeFocus {
  readonly kind: "routine" | "task";
  readonly id: string;
}

/**
 * Where an event line's subject opens: the home on that routine or task, a task's own screen once
 * it left the list, or nowhere for a routine that is gone. Absence needs a settled successful read;
 * the routines read is a live subscription whose every value is current (it always reports
 * waiting), so only its failure is unknown. The reads share the home's cache.
 */
export function useGoatBotEventTargets(
  member: { readonly botId: BotId; readonly sessionThreadId: ThreadId } | null,
): {
  readonly land: (subject: GoatBotEventSubject) => MobileBotHomeFocus | "task-screen" | null;
  /** Changes whenever a landing may have changed, for the list's row memo. */
  readonly key: string;
} {
  const home = useMobileGoatBotHomeMode();
  const selected = pickMobileGoatBotHomeEnvironment(home.environments, home.botRef);
  const environmentId = selected?.environmentId ?? null;
  const { presentationById } = useEnvironments();
  const capabilities = environmentId
    ? presentationById.get(environmentId)?.serverConfig?.environment.capabilities
    : undefined;
  const enabled = selected?.connected === true && capabilities?.goatBotTaskThreads === true;
  const threads = useEnvironmentQuery(
    environmentId && enabled && (member === null || capabilities?.goatBotMembers === true)
      ? channelEnvironment.listBotThreads({
          environmentId,
          input: member === null ? {} : { botId: member.botId },
        })
      : null,
  );
  const routines = useEnvironmentQuery(
    environmentId && selected?.connected
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const botThreadId = member?.sessionThreadId ?? home.botRef?.threadId ?? null;
  const routineIds =
    routines.data && routines.error === null
      ? new Set<string>(
          routines.data.tasks
            .filter((task) => task.threadId === botThreadId)
            .map((task) => task.id),
        )
      : null;
  const taskIds =
    threads.data && threads.error === null && !threads.isPending
      ? new Set<string>(
          threads.data.rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
        )
      : null;
  const land = (subject: GoatBotEventSubject) => {
    if (subject.kind === "routine") {
      return routineIds === null || routineIds.has(subject.id)
        ? { kind: "routine" as const, id: subject.id }
        : null;
    }
    return taskIds === null || taskIds.has(subject.id)
      ? { kind: "task" as const, id: subject.id }
      : "task-screen";
  };
  const key = `${routineIds === null ? "?" : [...routineIds].join(",")}|${taskIds === null ? "?" : [...taskIds].join(",")}`;
  return { land, key };
}
