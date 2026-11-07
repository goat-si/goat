import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claudeAccountDirectory,
  planClaudeAccountEdit,
  planClaudeAccountRemoval,
} from "./claude-account-plan";
import type { SettingsTarget } from "./settings-environment-filter";

export function ClaudeAccountControls({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const environmentId = environment.environmentId;
  const configAtom = serverEnvironment.configProjection({ environmentId, input: {} });
  const config = useEnvironmentQuery(configAtom);
  const permitted = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const hasScope = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const [opened, setOpened] = useState<ProviderInstanceConfig | null>(null);
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const instance = config.data?.config.settings.providerInstances[provider.instanceId];
  const enabled =
    permitted &&
    hasScope &&
    instance !== undefined &&
    !config.isPending &&
    config.error === null &&
    !pending;
  const removal = planClaudeAccountRemoval(provider.instanceId);
  async function save(kind: "edit" | "remove", snapshot: ProviderInstanceConfig) {
    if (pendingRef.current || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    const latest = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(configAtom)))?.config;
    const current = latest?.settings.providerInstances[provider.instanceId];
    if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)) {
      setError("This account changed. Reopen it and try again.");
      setOpened(null);
      return;
    }
    const mutation =
      kind === "edit"
        ? planClaudeAccountEdit(
            provider.instanceId,
            current,
            directory,
            latest?.environment.capabilities.providerInstancePreconditions === true,
            name,
          )
        : removal;
    if (!mutation) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    await mutate({
      environmentId,
      input: { patch: {}, providerInstanceMutation: mutation },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : "Could not update the Claude account.",
          );
          return;
        }
        setOpened(null);
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }
  return (
    <View className="gap-2 px-4 pb-3">
      {opened ? (
        <>
          <TextInput
            accessibilityLabel="Account name"
            value={name}
            onChangeText={setName}
            editable={!pending}
            autoCorrect={false}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          />
          <TextInput
            accessibilityLabel="Claude config folder"
            value={directory}
            onChangeText={setDirectory}
            editable={!pending}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          />
          <View className="flex-row gap-2">
            <ControlPill
              variant="pill"
              label="Cancel"
              disabled={pending}
              onPress={() => setOpened(null)}
            />
            <ControlPill
              variant="primary"
              label="Save"
              disabled={!enabled}
              onPress={() => void save("edit", opened)}
            />
          </View>
        </>
      ) : (
        <View className="flex-row gap-2">
          <ControlPill
            variant="pill"
            label="Edit account"
            disabled={!enabled}
            onPress={() => {
              if (!instance) return;
              setError(null);
              setDirectory(claudeAccountDirectory(instance));
              setName(instance.displayName ?? "");
              setOpened(instance);
            }}
          />
          {removal ? (
            <ControlPill
              variant="pill"
              label="Remove account"
              disabled={!enabled}
              onPress={() => {
                if (!instance) return;
                Dialog.alert(
                  `Remove ${provider.displayName ?? "Claude account"}?`,
                  "The config folder and its sign-in stay on the environment.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove",
                      style: "destructive",
                      onPress: () => void save("remove", instance),
                    },
                  ],
                );
              }}
            />
          ) : null}
        </View>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
