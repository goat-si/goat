import { useAtomValue } from "@effect/atom-react";
import { BOT_TASK_SNOOZE_CHOICES, botTaskSnoozeInput } from "@goat/client-runtime/goatBot";
import type { BotId, ChannelTaskView, ContextMenuItem, EnvironmentId } from "@goat/contracts";
import { readLocalApi } from "~/localApi";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

export const botTaskSnoozeMenu = (view: ChannelTaskView): ContextMenuItem =>
  view.snoozedUntil === undefined
    ? { id: "snooze", label: "Snooze", children: BOT_TASK_SNOOZE_CHOICES }
    : { id: "unsnooze", label: "Unsnooze" };

export function useGoatBotTaskSnooze(environmentId: EnvironmentId, supported: boolean) {
  const snooze = channelEnvironment.snoozeBotTask;
  const unsnooze = channelEnvironment.unsnoozeBotTask;
  const canSnooze = useAtomValue(
    (supported ? snooze : channelEnvironment.updateTaskView).permissionAtom(environmentId),
  );
  const canUnsnooze = useAtomValue(
    (supported ? unsnooze : channelEnvironment.updateTaskView).permissionAtom(environmentId),
  );
  const sendSnooze = useAtomCommand(supported ? snooze : channelEnvironment.updateTaskView);
  const sendUnsnooze = useAtomCommand(supported ? unsnooze : channelEnvironment.updateTaskView);
  return {
    enabled: (view: ChannelTaskView) =>
      supported && (view.snoozedUntil === undefined ? canSnooze : canUnsnooze),
    change: async (action: string, view: ChannelTaskView, botId: BotId) => {
      if (!supported) return false;
      const input = { taskId: view.taskId, botId };
      if (action === "unsnooze" && canUnsnooze)
        return (await sendUnsnooze({ environmentId, input }))._tag === "Success";
      if (!canSnooze) return false;
      const snoozeInput = botTaskSnoozeInput(action);
      return (
        snoozeInput !== undefined &&
        (await sendSnooze({ environmentId, input: { ...input, ...snoozeInput } }))._tag ===
          "Success"
      );
    },
  };
}

export function GoatBotTaskSnooze({
  environmentId,
  botId,
  view,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly view: ChannelTaskView;
  readonly onChange: () => void;
}) {
  const snooze = useGoatBotTaskSnooze(environmentId, true);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!snooze.enabled(view)}
      aria-haspopup={view.snoozedUntil === undefined ? "menu" : undefined}
      onClick={(event) => {
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        const choose =
          view.snoozedUntil === undefined
            ? readLocalApi()
                ?.contextMenu.show(BOT_TASK_SNOOZE_CHOICES, { x: left, y: bottom })
                .catch(() => null)
            : Promise.resolve("unsnooze");
        void choose?.then(async (choice) => {
          if (choice !== null && (await snooze.change(choice, view, botId))) onChange();
        });
      }}
    >
      {view.snoozedUntil === undefined ? "Snooze" : "Unsnooze"}
    </Button>
  );
}
