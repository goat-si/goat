import { AuthOrchestrationOperateScope, type ModelSelection } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import * as Dialog from "../components/ui/Dialog";
import { readEnvironmentScope } from "./session";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function usePersistThreadModel() {
  const setModel = useAtomCommand(threadEnvironment.setModelSelection, { reportFailure: false });
  return (thread: EnvironmentThreadShell | null, value: ModelSelection) => {
    if (
      !thread ||
      thread.modelSelection.instanceId !== value.instanceId ||
      !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    void setModel({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, modelSelection: value },
    }).then((result) => {
      if (result._tag === "Failure")
        Dialog.alert(
          "Could not apply model selection",
          "This model pick was not saved. Try again.",
        );
    });
  };
}
