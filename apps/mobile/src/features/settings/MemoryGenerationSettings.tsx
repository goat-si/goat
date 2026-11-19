import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { supportsMemoryProtocol, type EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { useContext, useEffect, useRef, useState } from "react";
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
export function MemoryGeneration({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SettingsSection title="Memory">
      <Copy>
        GOAT summarizes finished conversations. Turning this off stops new summaries and keeps saved
        memories.
      </Copy>
      <SettingsSwitchRow
        label="Remember conversations"
        value={config?.settings.memoryEnabled ?? true}
        disabled={!allowed || !config || busy}
        onValueChange={(value) => {
          if (
            pending.current ||
            !registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))
          )
            return;
          pending.current = true;
          setBusy(true);
          void update({ environmentId, input: { patch: { memoryEnabled: value } } })
            .then((result) => {
              if (live())
                setNotice(
                  result._tag === "Success" ? "Memory updated." : "Could not update memory.",
                );
            })
            .finally(() => {
              pending.current = false;
              if (live()) setBusy(false);
            });
        }}
      />
      {notice ? <Copy>{notice}</Copy> : null}
    </SettingsSection>
  );
}

export function MemoryAgentAccess({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SettingsSection title="Agent memory access">
      <Copy>
        Allow agents in this environment to use memory. Sharing is managed separately. Turning this
        on does not increase saved task access.
      </Copy>
      <SettingsSwitchRow
        label="Allow agent memory access"
        value={config?.settings.enableAgentMemoryAccess ?? false}
        disabled={!allowed || !config || busy}
        onValueChange={(value) => {
          if (
            pending.current ||
            !registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))
          )
            return;
          pending.current = true;
          setBusy(true);
          void update({ environmentId, input: { patch: { enableAgentMemoryAccess: value } } })
            .then((result) => {
              if (live())
                setNotice(
                  result._tag === "Success"
                    ? "Agent memory access updated."
                    : "Could not update agent memory access. Try again.",
                );
            })
            .finally(() => {
              pending.current = false;
              if (live()) setBusy(false);
            });
        }}
      />
      {notice ? <Copy>{notice}</Copy> : null}
    </SettingsSection>
  );
}
