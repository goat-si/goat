import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@goat/client-runtime/relay";
import type { EnvironmentId } from "@goat/contracts";
import { useRef, useState } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { LocalEnvironmentList } from "../connection/LocalEnvironmentList";
import { PullRequestRoutingSettings } from "../connection/PullRequestRoutingSettings";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { selectHubEnvironmentId } from "../connection/hubEnvironment";
import { useStoredHubEnvironment } from "../connection/useStoredHubEnvironment";
import { useConnectionsReady } from "../../state/workspace";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
  SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS,
} from "../showcase/showcaseEnvironmentRows";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentSections = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(environmentSections.localEnvironments)
    : environmentSections.localEnvironments;
  const connectedCloudEnvironments = SHOWCASE_ENABLED
    ? SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS
    : environmentSections.connectedCloudEnvironments;
  const savedHub = useStoredHubEnvironment();
  const catalogReady = useConnectionsReady();
  const hubEnvironmentId = selectHubEnvironmentId(localEnvironments, savedHub.storedHubId);
  const hub = localEnvironments.find(
    (environment) => environment.environmentId === hubEnvironmentId,
  );
  const savedRelaySession = useAtomValue(managedRelaySessionAtom);
  const relaySession = isGoatConnectEnabled() ? savedRelaySession : null;
  const refreshRelayEnvironments = useAtomCommand(
    relayEnvironmentDiscovery.refresh,
    "relay environment refresh",
  );
  const [isRefreshingCloud, setIsRefreshingCloud] = useState(false);
  const cloudRefreshPendingRef = useRef(false);
  async function refreshCloudEnvironments() {
    if (!relaySession || cloudRefreshPendingRef.current) return;
    cloudRefreshPendingRef.current = true;
    setIsRefreshingCloud(true);
    await refreshRelayEnvironments();
    cloudRefreshPendingRef.current = false;
    setIsRefreshingCloud(false);
  }

  const openEnvironment = (environmentId: EnvironmentId) => {
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });
  };
  const handleUpdateEnvironment = (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => {
    if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
    const actualEnvironment = environmentSections.localEnvironments.find(
      (environment) => environment.environmentId === environmentId,
    );
    const presentedEnvironment = localEnvironments.find(
      (environment) => environment.environmentId === environmentId,
    );
    return onUpdateEnvironment(environmentId, {
      ...updates,
      displayUrl:
        actualEnvironment && presentedEnvironment
          ? resolveShowcaseEnvironmentUpdateDisplayUrl({
              actualDisplayUrl: actualEnvironment.displayUrl,
              presentedDisplayUrl: presentedEnvironment.displayUrl,
              submittedDisplayUrl: updates.displayUrl,
            })
          : updates.displayUrl,
    });
  };

  return (
    <SettingsScreen
      title="Environments"
      trailing={
        Platform.OS === "android" && relaySession ? (
          <AndroidAnchoredMenu
            title="Environment options"
            actions={[
              {
                id: "refresh",
                title: "Refresh cloud environments",
                attributes: { disabled: isRefreshingCloud },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "refresh") void refreshCloudEnvironments();
            }}
          >
            {(open) => (
              <AndroidHeaderIconButton
                accessibilityLabel="Environment options"
                icon="ellipsis"
                onPress={open}
              />
            )}
          </AndroidAnchoredMenu>
        ) : undefined
      }
      actions={[
        {
          accessibilityLabel: "Add environment",
          icon: "plus",
          tintColor: headerIconColor,
          onPress: () => navigation.navigate("SettingsEnvironmentNew"),
        },
      ]}
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          relaySession ? (
            <RefreshControl
              refreshing={isRefreshingCloud}
              onRefresh={() => void refreshCloudEnvironments()}
            />
          ) : undefined
        }
      >
        <View className="mb-4 gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={!savedHub.loaded || !catalogReady}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsEnvironmentNew",
                  params: hubEnvironmentId
                    ? { intent: "change-hub", replaceEnvironmentId: hubEnvironmentId }
                    : { intent: "hub" },
                },
              })
            }
            className="min-h-13 flex-row items-center gap-3 rounded-[24px] bg-grouped-card px-4 active:opacity-70"
          >
            <View className="min-w-0 flex-1 py-3">
              <Text className="text-base text-foreground">
                {hub ? "Change hub" : "Connect hub"}
              </Text>
              {hub ? (
                <Text className="text-sm text-foreground-muted">{hub.environmentLabel}</Text>
              ) : null}
            </View>
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          </Pressable>
          {savedHub.error ? (
            <Text className="px-4 text-sm text-danger-foreground">{savedHub.error}</Text>
          ) : null}
        </View>
        {localEnvironments.length > 0 ? (
          <LocalEnvironmentList
            environments={localEnvironments}
            expandedId={null}
            onToggle={openEnvironment}
            opensDetails
            onReconnect={onReconnectEnvironment}
            onRemove={onRemoveEnvironmentPress}
            onSetEnabled={onSetEnvironmentEnabled}
            onUpdate={handleUpdateEnvironment}
          />
        ) : null}

        {/* Keep connected relays visible and removable without cloud config or sign-in; this component gates discovery. */}
        <CloudEnvironmentRows
          connectedCloudEnvironments={connectedCloudEnvironments}
          onOpenEnvironment={openEnvironment}
          onSetEnvironmentEnabled={onSetEnvironmentEnabled}
          onRemoveEnvironment={onRemoveEnvironmentPress}
          {...(SHOWCASE_ENABLED
            ? {
                showcaseAvailableEnvironments: SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
                showcaseSignedIn: true,
              }
            : {})}
        />
        <View className="mt-6 gap-2">
          <Text className="px-4 text-sm font-goat-medium text-foreground-muted">Advanced</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              navigation.navigate("SettingsEnvironmentNew", { intent: "add-server" })
            }
            className="min-h-13 flex-row items-center gap-3 rounded-[24px] bg-grouped-card px-4 active:opacity-70"
          >
            <Text className="flex-1 text-base text-foreground">Add another server</Text>
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          </Pressable>
        </View>
        <PullRequestRoutingSettings />
      </ScrollView>
    </SettingsScreen>
  );
}
