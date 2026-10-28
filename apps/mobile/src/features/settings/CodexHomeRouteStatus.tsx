import { useAtomValue } from "@effect/atom-react";
import {
  codexRouteErrorMessage,
  openCodexHomeHandoff,
  openCodexRouteSummary,
  providerHomeNeedsSetup,
  providerHomeRouteSummary,
  resolveProviderInstanceDisplayName,
  supportsProviderHome,
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
import { useNavigation } from "@react-navigation/native";
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

type AccountProvider = Pick<
  ServerProvider,
  "driver" | "codexRoute" | "homeRoute" | "setup" | "installed"
>;

/** The provider signs in from this app. */
export function signsInHere(provider: AccountProvider) {
  return Boolean(
    provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed),
  );
}

/** Whether the provider's model requests go through OpenCodex Home, as its snapshot reports. */
export function routesThroughHome(provider: AccountProvider) {
  const route = provider.driver === "codex" ? provider.codexRoute : provider.homeRoute;
  return route?.modelRoute === "opencodex";
}

/** Home routing stays reachable for the four adapters that support it, sign-in or not. */
export function includesProviderAccount(provider: AccountProvider) {
  return signsInHere(provider) || supportsProviderHome(provider.driver);
}

type CodexRouteChange =
  | { readonly modelRoute: "default" }
  | { readonly modelRoute: "opencodex"; readonly opencodexAuth?: CodexHomeAuth }
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

const UPDATE_GOAT_FOR_HOME = "Update GOAT on this machine to change Home authentication.";

/**
 * Confirms a change chosen in an Alert against the instance as it is now. If another device
 * changed the route since the Alert opened, nothing is written; otherwise only the change is
 * applied over the latest instance. Servers without providerInstancePreconditions would drop that
 * guard and the authentication field, so nothing is sent to them.
 */
export async function confirmCodexRouteChange(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly opened: ProviderInstanceConfig | undefined;
  /** The instance and the server's capabilities as the environment reports them now. */
  readonly readLatest: () => {
    readonly instance: ProviderInstanceConfig | undefined;
    readonly supportsPreconditions: boolean;
  };
  readonly change: CodexRouteChange;
  readonly mutate: (mutation: ReturnType<typeof buildDefaultCodexRouteMutation>) => Promise<void>;
}) {
  const { instance: latest, supportsPreconditions } = input.readLatest();
  if (!supportsPreconditions) throw new Error(UPDATE_GOAT_FOR_HOME);
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
  titled = true,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  /** False when the provider's account row above already names the instance. */
  readonly titled?: boolean;
}) {
  const navigation = useNavigation();
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
  const codex = provider.driver === "codex";
  const route = codex ? provider.codexRoute : provider.homeRoute;
  const settings = config.data?.config.settings;
  const instance = settings?.providerInstances[provider.instanceId];
  const supportsPreconditions =
    config.data?.config.environment.capabilities.providerInstancePreconditions === true;
  const managed = codex && configValue(instance, "setupMode") === "managed";
  const homeAuth: CodexHomeAuth =
    managed || configValue(instance, "opencodexAuth") === "none" ? "none" : "openai";
  const usesHome =
    instance === undefined
      ? route?.modelRoute === "opencodex"
      : configValue(instance, "modelRoute") === "opencodex";
  const canWrite =
    canManage && instance !== undefined && !config.isPending && config.error === null;
  /** The instance and capabilities as the environment reports them now, read when a confirmation is accepted. */
  const readLatestInstance = () => {
    const latest = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(configAtom)))?.config;
    return {
      instance: latest?.settings.providerInstances[provider.instanceId],
      supportsPreconditions:
        latest?.environment.capabilities.providerInstancePreconditions === true,
    };
  };
  /**
   * Without a change this only refreshes. A change is checked against the instance captured when
   * it was chosen, then written to the selected environment.
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
  const changeRoute = () => {
    const change: CodexRouteChange = usesHome
      ? { modelRoute: "default" }
      : { modelRoute: "opencodex", ...(codex ? { opencodexAuth: homeAuth } : {}) };
    // Codex confirms a route change; for the other adapters this action is the consent.
    if (!codex) return void run(change, instance);
    const disconnect = openCodexHomeHandoff({
      environmentLabel: environment.label,
      action: "disconnect",
    });
    Alert.alert(
      usesHome ? disconnect.title : "Use OpenCodex Home",
      usesHome
        ? disconnect.instruction
        : `Codex on ${environment.label} will send model requests through OpenCodex Home and use its accounts and shared quota${homeAuth === "none" ? ", without a sign-in on this machine" : ""}. If Home is unavailable, this instance stops working instead of switching accounts.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: usesHome ? disconnect.title : "Use OpenCodex Home",
          onPress: () => void run(change, instance),
        },
      ],
    );
  };
  const summary = codex
    ? provider.codexRoute?.state === "not_running"
      ? `OpenCodex isn't running on ${environment.label}.`
      : (openCodexRouteSummary(route) ??
        (usesHome ? "OpenCodex Home status not checked. Check status." : undefined))
    : (providerHomeRouteSummary(provider) ??
      (usesHome ? "OpenCodex Home route not checked. Check status." : undefined));
  // A default route with no action here adds nothing below the provider's own account row.
  if (!titled && !usesHome && !canManage) return null;
  return (
    <View className="gap-3 p-4">
      {titled ? (
        <Text className="font-goat-bold text-base text-foreground">
          {resolveProviderInstanceDisplayName(provider)}
        </Text>
      ) : null}
      {summary === undefined ? null : (
        <Text className="text-sm text-foreground-muted">{summary}</Text>
      )}
      {canManage ? (
        <SettingsActionRow
          icon={usesHome ? "xmark" : "globe"}
          label={usesHome ? "Stop using OpenCodex Home" : "Use OpenCodex Home"}
          description={
            !supportsPreconditions && instance !== undefined
              ? UPDATE_GOAT_FOR_HOME
              : usesHome
                ? undefined
                : "Uses Home's accounts and shared quota."
          }
          disabled={pending || !canWrite || !supportsPreconditions}
          onPress={changeRoute}
        />
      ) : null}
      {usesHome && providerHomeNeedsSetup(provider.driver, route) ? (
        <SettingsActionRow
          icon="desktopcomputer"
          label="Open Hub devices"
          description={
            openCodexHomeHandoff({ environmentLabel: environment.label, action: "connect" })
              .instruction
          }
          onPress={() => navigation.navigate("SettingsHubNodes")}
        />
      ) : null}
      {codex && usesHome && canManage && instance ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label="Home authentication"
          description={
            supportsPreconditions ? (homeAuth === "none" ? "None" : "OpenAI") : UPDATE_GOAT_FOR_HOME
          }
          disabled={pending || !canWrite || !supportsPreconditions}
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
      {usesHome ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Check status"
          loading={pending}
          disabled={pending || !canRefresh}
          onPress={() => void run()}
        />
      ) : null}
      {error || config.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error ?? config.error}
        </Text>
      ) : null}
    </View>
  );
}
