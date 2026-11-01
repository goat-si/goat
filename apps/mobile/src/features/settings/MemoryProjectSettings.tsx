import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { AppState } from "react-native";
import {
  type EnvironmentId,
  type MemoryProjectBinding,
  type MemorySpaceId,
  type ScopedProjectRef,
} from "@goat/contracts";
import * as Crypto from "expo-crypto";
import { MemoryOperationId } from "@goat/contracts";
import { memoryEnvironment as memory } from "../../state/memory";
import { MemoryProjectPicker } from "./MemoryProjectPicker";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";

/** Only the binding version returned by the server authorizes a subsequent CAS. */
export function MemoryProjectSettings({
  environmentId,
  memorySpaceId,
  project,
  onBinding,
  beforeChange,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  project: ScopedProjectRef;
  onBinding: (binding: MemoryProjectBinding | null) => void;
  beforeChange: () => Promise<void>;
}) {
  const registry = useContext(RegistryContext);
  const get = useAtomCommand(memory.projectBindingGet, { reportFailure: false });
  const update = useAtomCommand(memory.projectBindingUpdate, { reportFailure: false });
  const allowed = useAtomValue(memory.projectBindingUpdate.permissionAtom(environmentId));
  const [binding, setBinding] = useState<MemoryProjectBinding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    const result = await get({ environmentId, input: { memorySpaceId, project } });
    if (token !== generation.current) return;
    if (result._tag === "Success") {
      setBinding(result.value);
      onBinding(result.value);
    } else {
      setBinding(null);
      onBinding(null);
      setNotice("Project binding unavailable. Review the latest binding before changing it.");
    }
  }, [environmentId, memorySpaceId, project, get, onBinding]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active" && !pending.current) void load();
      });
      return () => {
        generation.current++;
        subscription.remove();
      };
    }, [load]),
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function save(
    action: "setExplicit" | "useRepository",
    sharedProjectId = Crypto.randomUUID(),
  ) {
    if (
      !binding ||
      pending.current ||
      !registry.get(memory.projectBindingUpdate.permissionAtom(environmentId))
    )
      return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    const token = ++generation.current;
    try {
      await beforeChange();
      if (token !== generation.current) return;
      const result = await update({
        environmentId,
        input: {
          memorySpaceId,
          project,
          requestId: MemoryOperationId.make(Crypto.randomUUID()),
          expectedVersion: binding.version,
          ...(action === "setExplicit" ? { action, sharedProjectId } : { action }),
        },
      });
      if (token !== generation.current) return;
      if (result._tag === "Success") {
        setBinding(result.value.binding);
        onBinding(result.value.binding);
        setNotice("Project binding updated for future memories. Existing scopes stay unchanged.");
      } else {
        setBinding(null);
        onBinding(null);
        setNotice(
          "Project binding changed or could not be saved. Review the latest binding before trying again.",
        );
      }
    } catch {
      if (token === generation.current)
        setNotice(
          "Could not retire the previous import. Reopen Settings before changing the binding.",
        );
    } finally {
      pending.current = false;
      if (token === generation.current) setBusy(false);
    }
  }
  return (
    <SettingsSection title="Project memory binding">
      <Text className="p-3 text-sm text-foreground-muted">
        {binding?.projectKey?.kind === "explicit"
          ? "Using a shared project binding"
          : binding?.repositoryKey
            ? "Using the repository binding"
            : "No repository binding available"}
      </Text>
      <SettingsActionRow
        icon="brain"
        label="Create shared project binding"
        disabled={!allowed || !binding || busy}
        onPress={() => void save("setExplicit")}
      />
      <MemoryProjectPicker
        environmentId={environmentId}
        excludeProjectId={project.projectId}
        label="Choose shared binding project…"
        candidateLabel="Use shared binding from "
        disabled={!allowed || !binding || busy}
        onSelect={(projectId) => {
          const token = generation.current;
          void get({
            environmentId,
            input: { memorySpaceId, project: { environmentId, projectId } },
          }).then((result) => {
            if (token !== generation.current) return;
            if (result._tag === "Success" && result.value.projectKey?.kind === "explicit")
              void save("setExplicit", result.value.projectKey.sharedProjectId);
            else
              setNotice(
                "That project has no shared binding. Create a shared binding there first, then select it here.",
              );
          });
        }}
      />
      <SettingsActionRow
        icon="brain"
        label="Use repository binding"
        disabled={!allowed || !binding || busy}
        onPress={() => void save("useRepository")}
      />
      <SettingsActionRow
        icon="brain"
        label="Review latest project binding"
        disabled={busy}
        onPress={() => void load()}
      />
      {notice ? <Text className="p-3 text-sm text-foreground-muted">{notice}</Text> : null}
    </SettingsSection>
  );
}
