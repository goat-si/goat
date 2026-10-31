import { useAtomValue } from "@effect/atom-react";
import { createComputerUseHistoryCommand } from "@goat/client-runtime/state/computer-use-history";
import type { ComputerUseHistoryCursor, EnvironmentId, ThreadId } from "@goat/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadComputerUseHistoryView } from "./ThreadComputerUseHistoryView";

const command = createComputerUseHistoryCommand(connectionAtomRuntime);

export function ThreadComputerUseHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canRead = useAtomValue(command.permissionAtom(props.environmentId));
  const request = useAtomCommand(command, { reportFailure: false });
  const load = async (before: typeof ComputerUseHistoryCursor.Type | null) => {
    const result = await request({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, limit: 30, ...(before === null ? {} : { before }) },
    });
    if (result._tag === "Failure") throw new Error("Could not load input history.");
    return result.value;
  };
  return <ThreadComputerUseHistoryView canRead={canRead} load={load} />;
}
