import { useAtomValue } from "@effect/atom-react";
import {
  codexRouteErrorMessage,
  openCodexHomeHandoff,
  openCodexRouteSummary,
  resolveProviderInstanceDisplayName,
} from "@goat/client-runtime/state/provider-instance-display";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import type { SettingsTarget } from "./settings-environment-filter";

/** Home instances remain visible even when native account sign-in is unavailable. */
export function includesProviderAccount(
  provider: Pick<ServerProvider, "driver" | "codexRoute" | "setup" | "installed">,
) {
  return (
    provider.setup?.canAuthenticate ||
    (provider.driver === "acpRegistry" && provider.installed) ||
    (provider.driver === "codex" && provider.codexRoute?.modelRoute === "opencodex")
  );
}

export function buildDefaultCodexRouteMutation(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
) {
  const config =
    typeof instance.config === "object" && instance.config !== null ? instance.config : {};
  return {
    environmentId,
    input: {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert" as const,
        instanceId,
        instance: { ...instance, config: { ...config, modelRoute: "default" } },
      },
    },
  };
}

export function CodexHomeRouteStatus({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const environmentId = environment.environmentId;
  const config = useEnvironmentQuery(
    serverEnvironment.configProjection({ environmentId, input: {} }),
  );
  const canManageScope = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canMutate = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const canManage = canMutate && canManageScope;
  const canReadProviders = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canRefreshPermission = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(environmentId),
  );
  const canRefresh = canReadProviders && canRefreshPermission;
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(false);
  const handoff = openCodexHomeHandoff({ environmentLabel: environment.label, action: "connect" });
  const settings = config.data?.config.settings;
  const instance = settings?.providerInstances[provider.instanceId];
  async function run(disconnect: boolean) {
    if (pendingRef.current) return;
    if (disconnect && !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (disconnect) {
        if (!instance) throw new Error("Refresh settings and try again.");
        const result = await mutate(
          buildDefaultCodexRouteMutation(environmentId, provider.instanceId, instance),
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      const result = await refresh({
        environmentId,
        input: { instanceId: provider.instanceId, fresh: true, refreshModels: true },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (failure) {
      setError(codexRouteErrorMessage(failure));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const summary =
    provider.codexRoute?.state === "not_running"
      ? `OpenCodex isn't running on ${environment.label}.`
      : openCodexRouteSummary(provider.codexRoute);
  return (
    <View className="gap-3 p-4">
      <Text className="font-goat-bold text-base text-foreground">
        {resolveProviderInstanceDisplayName(provider)}
      </Text>
      <Text className="text-sm text-foreground-muted">{summary}</Text>
      {canManage ? (
        <SettingsActionRow
          icon="globe"
          label="Connect to Home"
          disabled={pending}
          onPress={() => setInstructions(true)}
        />
      ) : null}
      {instructions ? (
        <Text className="text-sm text-foreground-muted">{handoff.instruction}</Text>
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check status"
        loading={pending}
        disabled={pending || !canRefresh}
        onPress={() => void run(false)}
      />
      {canManage ? (
        <SettingsActionRow
          icon="xmark"
          label="Stop using OpenCodex Home"
          disabled={pending || !instance || config.isPending || config.error !== null}
          onPress={() => {
            const disconnect = openCodexHomeHandoff({
              environmentLabel: environment.label,
              action: "disconnect",
            });
            Alert.alert(disconnect.title, disconnect.instruction, [
              { text: "Cancel", style: "cancel" },
              { text: disconnect.title, onPress: () => void run(true) },
            ]);
          }}
        />
      ) : null}
      <Text className="text-sm text-foreground-muted">
        Add a Codex · OpenCodex Home instance in web or desktop Settings.
      </Text>
      {error || config.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error ?? config.error}
        </Text>
      ) : null}
    </View>
  );
}
