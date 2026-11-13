import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelUpdateTaskViewInput, EnvironmentId } from "@goat/contracts";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

/** Pins, marks done or marks read one task; says why when the server refuses. */
export async function updateMobileTaskView(
  environmentId: EnvironmentId,
  input: ChannelUpdateTaskViewInput,
): Promise<boolean> {
  const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateTaskView, {
    environmentId,
    input,
  });
  if (result._tag === "Success") return true;
  const error = squashAtomCommandFailure(result);
  Alert.alert(
    "Could not update task",
    error instanceof Error ? error.message : "Please try again.",
  );
  return false;
}
