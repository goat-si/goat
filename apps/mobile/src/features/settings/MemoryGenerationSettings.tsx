import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { supportsMemoryProtocol, type EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { useContext, useEffect, useRef, useState } from "react";
import { I18nProvider, useGT } from "../../i18n/I18nProvider";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { Copy } from "./memoryScreenParts";

/** A dialog and its callbacks belong to one connected screen lifetime. */
export function useMemoryLifetime(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const mounted = useRef(true);
  // oxlint-disable-next-line goat/react-effect-budget -- Async settings replies belong to the mounted screen.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    return (
      mounted.current &&
      Option.isSome(connection) &&
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)) === connection &&
      config !== null &&
      supportsMemoryProtocol(config.environment.capabilities)
    );
  };
}
export function MemoryConversationSettings({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <I18nProvider>
      <ConversationControls environmentId={environmentId} />
    </I18nProvider>
  );
}

function ConversationControls({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const supportsPause = config?.environment.capabilities.memory?.conversationMemoryControl === true;
  const paused = config?.settings.conversationMemoryEnabled === false;
  const disabled = !allowed || !config || busy;
  async function save(
    key: "conversationMemoryEnabled" | "memoryEnabled" | "enableAgentMemoryAccess",
    value: boolean,
  ) {
    if (
      pending.current ||
      !live() ||
      !registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))
    )
      return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    await update({ environmentId, input: { patch: { [key]: value } } })
      .then((result) => {
        if (live())
          setNotice(
            result._tag === "Success"
              ? gt("Memory settings updated.")
              : gt("Could not update memory settings."),
          );
      })
      .finally(() => {
        pending.current = false;
        if (live()) setBusy(false);
      });
  }
  return (
    <>
      <SettingsSection title={gt("Memory")}>
        {supportsPause && (
          <SettingsSwitchRow
            label={gt("Use GOAT memory in conversations")}
            subtitle={gt(
              "While paused, agents cannot read or save GOAT memories in this environment. Messages from this period are excluded from future summaries. A request that was already being sent when you paused may still finish.",
            )}
            value={!paused}
            disabled={disabled}
            onValueChange={(value) => void save("conversationMemoryEnabled", value)}
          />
        )}
        <SettingsSwitchRow
          label={gt("Remember conversations")}
          subtitle={gt(
            "GOAT summarizes finished conversations into memory. Turning this off stops new summaries and keeps saved memories.",
          )}
          value={config?.settings.memoryEnabled ?? true}
          disabled={disabled || paused}
          onValueChange={(value) => void save("memoryEnabled", value)}
        />
      </SettingsSection>
      <SettingsSection title={gt("Agent access")}>
        <SettingsSwitchRow
          label={gt("Allow agent memory access")}
          subtitle={gt(
            "Allow agents in this environment to use memory within their granted scope. This is separate from sharing memories between devices.",
          )}
          value={config?.settings.enableAgentMemoryAccess ?? false}
          disabled={disabled || paused}
          onValueChange={(value) => void save("enableAgentMemoryAccess", value)}
        />
      </SettingsSection>
      {notice ? <Copy>{notice}</Copy> : null}
    </>
  );
}
