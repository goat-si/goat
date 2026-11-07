import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { retryRefusalText } from "@goat/client-runtime/goatBot";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useContext, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { useGoatBotMember } from "./goatBotMemberContext";

/**
 * Runs failed or stopped work again. Each tap is its own request; the server may refuse it. A
 * started retry refreshes the bot's task list unless the caller refreshes its own.
 */
export function GoatBotTaskRetry({
  environmentId,
  taskId,
  onStarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly onStarted?: (() => void) | undefined;
}) {
  const retry = useAtomCommand(channelEnvironment.retryTask, {
    label: "GOAT Bot task retry",
    reportFailure: false,
  });
  const canRetry = useAtomValue(channelEnvironment.retryTask.permissionAtom(environmentId));
  const registry = useContext(RegistryContext);
  const member = useGoatBotMember();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!canRetry) return null;
  const refreshTasks = () =>
    registry.refresh(
      channelEnvironment.listBotThreads({
        environmentId,
        input: member === null ? {} : { botId: member.botId },
      }),
    );
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await retry({ environmentId, input: { taskId, clientRequestId: randomUUID() } });
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.status === "refused") setProblem(retryRefusalText(result.value.reason));
      else (onStarted ?? refreshTasks)();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setProblem(`Couldn't retry: ${failure instanceof Error ? failure.message : String(failure)}`);
  };
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void run()}>
        Retry
      </Button>
      {problem !== null ? (
        <p role="alert" className="max-w-56 text-right text-xs text-destructive-foreground">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
