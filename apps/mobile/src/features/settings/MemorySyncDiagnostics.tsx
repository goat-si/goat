import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { presentMemorySync } from "@goat/client-runtime/memory-presentation";
import type { EnvironmentId, MemoryHubDiagnostics, MemorySyncStatus } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { memoryEnvironment as memory } from "../../state/memory";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";

/** Settings-only diagnostics; rearming admission never establishes completed synchronization. */
export function MemorySyncDiagnostics({
  environmentId,
  status,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  status: MemorySyncStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(memory.hubDiagnostics.permissionAtom(environmentId));
  const canWrite = useAtomValue(memory.hubReconcile.permissionAtom(environmentId));
  const read = useAtomCommand(memory.hubDiagnostics, { reportFailure: false });
  const reconcile = useAtomCommand(memory.hubReconcile, { reportFailure: false });
  const [diagnostics, setDiagnostics] = useState<MemoryHubDiagnostics>();
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const capable = config?.environment.capabilities.memory?.hubDiagnostics === true;
  const load = useCallback(async () => {
    const token = ++generation.current;
    if (
      !capable ||
      !allowed ||
      !registry.get(memory.hubDiagnostics.permissionAtom(environmentId))
    ) {
      setDiagnostics(undefined);
      return;
    }
    const result = await read({ environmentId, input: {} });
    if (
      token !== generation.current ||
      !registry.get(memory.hubDiagnostics.permissionAtom(environmentId))
    )
      return;
    if (AsyncResult.isSuccess(result)) {
      setDiagnostics(result.value);
    } else {
      setDiagnostics(undefined);
      setNotice("Could not load sync diagnostics. Try again.");
    }
  }, [capable, allowed, registry, environmentId, read]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useFocusEffect(
    useCallback(() => {
      void load();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") void load();
      });
      return () => {
        generation.current++;
        subscription.remove();
      };
    }, [load]),
  );
  if (!status || !config) return null;
  const view = presentMemorySync(status, {
    capabilities: config.environment.capabilities,
    ...(allowed && diagnostics ? { diagnostics } : {}),
  });
  const copy = (label: string) => (
    <Text key={label} className="p-3 text-sm text-foreground-muted">
      {label}
    </Text>
  );
  return (
    <SettingsSection title="Memory sync">
      {copy(view.label)}
      {view.publicationLabel ? copy(view.publicationLabel) : null}
      {view.recoverableHolds.map((hold) =>
        copy(
          hold === "protocol"
            ? "Sync can resume after a protocol check."
            : "Sync can resume when memories are available.",
        ),
      )}
      {view.permanentHolds.map((hold) =>
        copy(
          hold === "identity"
            ? "Reconnect the correct memory space to resolve the identity hold."
            : "Restore authorization to resolve the access hold.",
        ),
      )}
      {capable && allowed ? (
        <SettingsActionRow
          icon="brain"
          label="Refresh sync diagnostics"
          onPress={() => void load()}
        />
      ) : null}
      {diagnostics && allowed ? (
        <>
          <SettingsActionRow
            icon="brain"
            label={details ? "Hide sync details" : "Show sync details"}
            onPress={() => setDetails(!details)}
          />
          {details ? copy(`Settings version: ${diagnostics.version}`) : null}
        </>
      ) : null}
      {view.canReconcileInSettings && canWrite && status.memorySpaceId && diagnostics ? (
        <SettingsActionRow
          icon="brain"
          label="Reconcile"
          disabled={busy}
          onPress={() => {
            if (pending.current || !registry.get(memory.hubReconcile.permissionAtom(environmentId)))
              return;
            pending.current = true;
            setBusy(true);
            const token = generation.current;
            void reconcile({
              environmentId,
              input: {
                environmentId,
                memorySpaceId: status.memorySpaceId!,
                expectedVersion: diagnostics.version,
              },
            })
              .then(async (result) => {
                if (token !== generation.current) return;
                setNotice(
                  AsyncResult.isSuccess(result)
                    ? "Sync retry accepted. Synchronization may still be pending."
                    : "Could not reconcile. Refresh diagnostics before trying again.",
                );
                await Promise.all([onRefresh(), load()]);
              })
              .finally(() => {
                pending.current = false;
                setBusy(false);
              });
          }}
        />
      ) : null}
      {notice ? copy(notice) : null}
    </SettingsSection>
  );
}
