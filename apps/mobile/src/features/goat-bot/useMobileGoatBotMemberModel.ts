import { useAtomValue } from "@effect/atom-react";
import { botManageFailure, deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { goatBotMemberModelChoice, goatBotMemberModelMenu } from "./goatBotModelMenu";

const NO_PERMISSION = Atom.make(false);

/**
 * Whether a member's model can change here. Older servers drop the key from `channel.updateBot`,
 * so only a server that advertises it is offered the edit.
 */
export function useMobileGoatBotMemberModelEditable(environmentId: EnvironmentId | null) {
  const { presentationById } = useEnvironments();
  const supported =
    environmentId !== null &&
    presentationById.get(environmentId)?.serverConfig?.environment.capabilities
      .goatBotMemberModelEdit === true;
  const permitted = useAtomValue(
    supported ? channelEnvironment.updateBot.permissionAtom(environmentId) : NO_PERMISSION,
  );
  return { supported, editable: supported && permitted };
}

/** Whether the server stores a member's colour; older ones drop the key, so they get no field. */
export function useMobileGoatBotColorEditable(environmentId: EnvironmentId | null): boolean {
  const { presentationById } = useEnvironments();
  return (
    environmentId !== null &&
    presentationById.get(environmentId)?.serverConfig?.environment.capabilities
      .goatBotProfileColor === true
  );
}

export type MobileGoatBotMemberModelMenu = NonNullable<
  ReturnType<typeof useMobileGoatBotMemberModelMenu>
>;

/** A member chat's header model: what its next turn uses, switchable where the server takes it. */
export function useMobileGoatBotMemberModelMenu(
  member: Pick<BotProfile, "botId" | "environmentId" | "name" | "defaultModelSelection"> | null,
  mainName: string,
) {
  const environmentId = member?.environmentId ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const { supported, editable } = useMobileGoatBotMemberModelEditable(environmentId);
  const [saving, setSaving] = useState(false);
  if (member === null || !config) return null;
  const state = deriveGoatBotModelSettings({
    settings: config.settings,
    providers: config.providers,
  });
  const canChange = editable && !saving;
  return {
    ...goatBotMemberModelMenu(state, member, mainName),
    canChange,
    // The menu opens even when it cannot change anything, so it says why.
    title: editable
      ? `${member.name}'s model`
      : supported
        ? `You can't change ${member.name}'s model`
        : `Update GOAT on ${member.name}'s computer to change its model`,
    select: (id: string) => {
      const next = goatBotMemberModelChoice(state, member.defaultModelSelection, id);
      if (next === undefined || !canChange) return;
      setSaving(true);
      void runAtomCommand(appAtomRegistry, channelEnvironment.updateBot, {
        environmentId: member.environmentId,
        input: { botId: member.botId, defaultModelSelection: next },
      }).then((result) => {
        setSaving(false);
        if (result._tag === "Failure")
          Alert.alert(
            `Couldn't change ${member.name}'s model`,
            botManageFailure(squashAtomCommandFailure(result)),
          );
      });
    },
  };
}
