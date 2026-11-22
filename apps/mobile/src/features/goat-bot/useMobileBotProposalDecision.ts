import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelResolveBotProposalInput, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";
import { Alert } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_PERMISSION = Atom.make(false);

export function useMobileBotProposalDecision(environmentId: EnvironmentId | null) {
  const allowed = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.resolveBotProposal.permissionAtom(environmentId),
  );
  const resolve = useCallback(
    async (input: ChannelResolveBotProposalInput) => {
      if (environmentId === null || !allowed) return false;
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.resolveBotProposal, {
        environmentId,
        input,
      });
      if (result._tag === "Success") return true;
      Alert.alert("Couldn't resolve proposal", botManageFailure(squashAtomCommandFailure(result)));
      return false;
    },
    [allowed, environmentId],
  );
  return allowed ? resolve : undefined;
}
