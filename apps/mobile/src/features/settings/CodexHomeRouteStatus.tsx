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
  type CodexHomeAuth,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { AppText as Text } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
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

type CodexRouteChange =
  | { readonly modelRoute: "default" }
  | { readonly opencodexAuth: CodexHomeAuth };

export function buildDefaultCodexRouteMutation(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  change: CodexRouteChange = { modelRoute: "default" },
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
        instance: { ...instance, config: { ...config, ...change } },
        // The server refuses the write if its instance no longer matches the one changed here.
        expectedInstance: instance,
      },
    },
  };
}

const configValue = (instance: ProviderInstanceConfig | undefined, key: string) =>
  typeof instance?.config === "object" && instance.config !== null && key in instance.config
    ? (instance.config as Record<string, unknown>)[key]
    : undefined;
const routeFields = (instance: ProviderInstanceConfig | undefined) =>
  ["setupMode", "modelRoute", "opencodexBaseUrl", "opencodexAuth"].map((key) =>
    configValue(instance, key),
  );

/**
 * Confirms a change chosen in an Alert against the instance as it is now. If another device
 * changed the route since the Alert opened, nothing is written; otherwise only the change is
 * applied over the latest instance.
 */
export async function confirmCodexRouteChange(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly opened: ProviderInstanceConfig | undefined;
  readonly readLatest: () => ProviderInstanceConfig | undefined;
  readonly change: CodexRouteChange;
  readonly mutate: (mutation: ReturnType<typeof buildDefaultCodexRouteMutation>) => Promise<void>;
}) {
  const latest = input.readLatest();
  const opened = routeFields(input.opened);
  if (
    latest === undefined ||
    input.opened === undefined ||
    routeFields(latest).some((value, index) => value !== opened[index])
  )
    throw new Error("Settings changed on another device. Review them and try again.");
  await input.mutate(
    buildDefaultCodexRouteMutation(input.environmentId, input.instanceId, latest, input.change),
  );
}

export function CodexHomeRouteStatus({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const environmentId = environment.environmentId;
  const configAtom = serverEnvironment.configProjection({ environmentId, input: {} });
  const config = useEnvironmentQuery(configAtom);
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
  const managed = configValue(instance, "setupMode") === "managed";
  const homeAuth: CodexHomeAuth =
    configValue(instance, "opencodexAuth") === "none" ? "none" : "openai";
  /** The instance as the environment reports it now, read when a confirmation is accepted. */
  const readLatestInstance = () =>
    Option.getOrNull(AsyncResult.value(appAtomRegistry.get(configAtom)))?.config.settings
      .providerInstances[provider.instanceId];
  /**
   * Without a change this only refreshes. A change confirmed in an Alert is checked against the
   * instance captured when that Alert opened, then written to the selected environment.
   */
  async function run(change?: CodexRouteChange, opened?: ProviderInstanceConfig) {
    if (pendingRef.current) return;
    if (change && !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (change)
        await confirmCodexRouteChange({
          environmentId,
          instanceId: provider.instanceId,
          opened,
          readLatest: readLatestInstance,
          change,
          mutate: async (mutation) => {
            const result = await mutate(mutation);
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        });
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
      {canManage && instance ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label="Home authentication"
          description={homeAuth === "none" ? "None" : "OpenAI"}
          disabled={pending || config.isPending || config.error !== null}
          onPress={() =>
            Alert.alert(
              "Home authentication",
              managed
                ? "Managed Codex uses Home without a sign-in. OpenAI authentication for Home needs an instance that uses your Codex CLI."
                : "None uses Home without a sign-in on this machine. OpenAI keeps this instance's own sign-in.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "None", onPress: () => void run({ opencodexAuth: "none" }, instance) },
                ...(managed
                  ? []
                  : [
                      {
                        text: "OpenAI",
                        onPress: () => void run({ opencodexAuth: "openai" }, instance),
                      },
                    ]),
              ],
            )
          }
        />
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Check status"
        loading={pending}
        disabled={pending || !canRefresh}
        onPress={() => void run()}
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
              {
                text: disconnect.title,
                onPress: () => void run({ modelRoute: "default" }, instance),
              },
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
