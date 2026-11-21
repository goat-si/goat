import { useAtomValue } from "@effect/atom-react";
import type { SessionStreamUpdate } from "@goat/client-runtime/rpc";
import type {
  BotId,
  ChannelChildWorkGroup,
  ChannelTaskChangesEvent,
  ChannelTaskId,
  ChannelUpdateTaskViewInput,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLayoutEffect, useRef } from "react";

import { channelEnvironment } from "../../state/channels";
import { updateMobileTaskView } from "./mobileTaskViewUpdate";
import { useMobileBotTaskLookup } from "./useMobileBotTaskLookup";

const identityOf = (owner: string, taskId: ChannelTaskId) => JSON.stringify([owner, taskId]);
const NO_PERMISSION = Atom.make(false);
const NO_TASK_CHANGES = Atom.make(
  AsyncResult.initial<SessionStreamUpdate<ChannelTaskChangesEvent>, never>(false),
);

/**
 * A task screen's lookup of a task the current list does not hold, and Pin, Done, Retry and read
 * marks on a bot's work with what each completion refreshes. On a task's own screen a completion
 * carries the computer, bot and task it was sent for; if the screen shows another by the time it
 * lands, or is gone, it is dropped whole: no list refresh, no reread.
 */
export function useMobileTaskScreen(input: {
  readonly environmentId: EnvironmentId | null;
  /** The computer and bot the screen shows. */
  readonly owner: string;
  readonly botId: BotId;
  /** The task screen's task; null on Home. */
  readonly taskId: ChannelTaskId | null;
  /** Connected, with a server that can change task views. */
  readonly enabled: boolean;
  readonly capabilities:
    | Pick<ExecutionEnvironmentCapabilities, "goatBotTaskLookupSearch" | "goatBotTaskChanges">
    | undefined;
  /** The bot's current-list read. */
  readonly list: {
    readonly data: unknown;
    readonly error: string | null;
    readonly isPending: boolean;
    readonly refresh: () => void;
  };
  /** The last successful current list holds the task. */
  readonly holdsTask: boolean;
  readonly needsApprovalObservation: boolean;
  readonly workRevision: string | null | undefined;
  readonly childGroups: ReadonlyArray<ChannelChildWorkGroup>;
}) {
  const { environmentId, capabilities } = input;
  const lookupSupported = capabilities?.goatBotTaskLookupSearch === true;
  const watchApprovals =
    input.needsApprovalObservation &&
    input.enabled &&
    lookupSupported &&
    capabilities.goatBotTaskChanges === true &&
    environmentId !== null &&
    input.taskId !== null;
  const mayWatchApprovals = useAtomValue(
    watchApprovals ? channelEnvironment.taskChangesPermission(environmentId) : NO_PERMISSION,
  );
  const watching = watchApprovals && mayWatchApprovals;
  const changes = useAtomValue(
    watching ? channelEnvironment.taskChanges({ environmentId, input: {} }) : NO_TASK_CHANGES,
  );
  const event = watching ? Option.getOrNull(AsyncResult.value(changes)) : null;
  const approvalRevision =
    event !== null && "value" in event
      ? `stream:${event.subscription}:${event.value.revision}`
      : input.needsApprovalObservation && input.workRevision != null
        ? `transcript:${input.workRevision}`
        : undefined;
  const { lookup, approvalTask, invalidate } = useMobileBotTaskLookup({
    environmentId: input.environmentId,
    botId: input.botId,
    taskId: input.taskId,
    supported: input.enabled && lookupSupported,
    established:
      input.list.data !== null || (input.needsApprovalObservation && input.list.error !== null),
    refreshing: input.list.isPending,
    holdsTask: input.holdsTask && !input.needsApprovalObservation,
    approvalRevision,
    childGroups: input.childGroups,
  });
  const permitted = useAtomValue(
    channelEnvironment.updateTaskView.permissionAtom(input.environmentId),
  );
  const identity = input.taskId === null ? null : identityOf(input.owner, input.taskId);
  const shown = useRef<string | null>(null);
  const latest = useRef({ refresh: input.list.refresh, invalidate });
  // oxlint-disable-next-line goat/react-effect-budget -- A completion compares the screen it was sent from with the one mounted when it lands.
  useLayoutEffect(() => {
    shown.current = identity;
    latest.current = { refresh: input.list.refresh, invalidate };
    return () => {
      shown.current = null;
    };
  });
  const settle = (sent: string) => {
    if (sent !== shown.current) return;
    latest.current.refresh();
    latest.current.invalidate();
  };
  const canUpdate = permitted && input.enabled;
  return {
    lookup: input.holdsTask ? { state: "off" as const } : lookup,
    approvalTask,
    /** This device may change task views here; the read mark's own gate as well. */
    permitted,
    canUpdate,
    update: async (change: ChannelUpdateTaskViewInput) => {
      const { environmentId } = input;
      const { refresh } = input.list;
      if (environmentId === null || !canUpdate) return false;
      const ok = await updateMobileTaskView(environmentId, change);
      if (ok) {
        if (identity === null) refresh();
        else settle(identity);
      }
      return ok;
    },
    /** A Retry the screen started was accepted. */
    retried: () => {
      if (identity !== null) settle(identity);
    },
    /**
     * A read mark sent for `scope` settled; `owned` says Home's walk took it. A task's own screen
     * rereads only for the computer, bot and task it was sent for; Home rereads its own list.
     */
    marked: (taskId: ChannelTaskId, scope: string, sent: boolean, owned: boolean) => {
      if (!sent) return;
      if (input.taskId !== null) settle(identityOf(scope, taskId));
      else if (owned) latest.current.refresh();
    },
  };
}
