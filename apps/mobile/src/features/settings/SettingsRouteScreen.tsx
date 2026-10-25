import { GOAT_CONNECT_COMING_SOON, isGoatConnectEnabled } from "@goat/shared/goatConnect";
import * as Dialog from "../../components/ui/Dialog";
import { MemoryEnvironmentEntry } from "./SettingsMemoryRouteScreen";
import {
  navigationCustomizationAvailable,
  overflowNavigationTabs,
} from "../workspace/navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "../workspace/navigation-tabs";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import {
  ScreenScrollView as ScrollView,
  ScreenScrollViewBottomInset,
} from "../../components/ui/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { Linking, Platform, View } from "react-native";
import type { ReactNode } from "react";
import { useWorkspaceSurface } from "../workspace/useWorkspaceSurface";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { deriveProjectGroupLabel } from "@goat/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useMobileGoatBotHomeSettings } from "../goat-bot/useMobileGoatBotHomeSettings";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const surface = useWorkspaceSurface();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <View className={`flex-1 ${surface.className}`}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerTransparent: false,
            headerStyle: { backgroundColor: surface.backgroundColor },
            contentStyle: { backgroundColor: surface.backgroundColor },
          }}
        />
      ) : null}
      <SettingsEnvironmentFilterHeader />
      <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
        {Platform.OS === "android" ? (
          <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
            {content}
          </SettingsScreen>
        ) : (
          content
        )}
      </ScreenScrollViewBottomInset>
    </View>
  );
}

function ConfiguredSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <View collapsable={false} className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <OverflowSection />
        <ConnectionsSection>
          <SettingsRow
            icon="person.crop.circle"
            label="GOAT Account"
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow icon="bell.badge" label="Notifications" target="SettingsNotifications" />
        </ConnectionsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <OverflowSection />
        <ConnectionsSection>
          {!isGoatConnectEnabled() ? (
            <SettingsRow
              icon="globe"
              label={`${GOAT_CONNECT_COMING_SOON.title} · ${GOAT_CONNECT_COMING_SOON.status}`}
              value={GOAT_CONNECT_COMING_SOON.description}
              valuePosition="below"
              onPress={() => {
                void Linking.openURL(GOAT_CONNECT_COMING_SOON.guideUrl).catch(() => {
                  Dialog.alert("Could not open guide", "Try opening the Tailscale guide again.");
                });
              }}
            />
          ) : null}
        </ConnectionsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

/** Both sign-in states list the hub's devices and saved environments the same way. */
function ConnectionsSection({ children }: { readonly children?: ReactNode }) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <SettingsSection title="Connections">
      <SettingsRow icon="desktopcomputer" label="Hub devices" target="SettingsHubNodes" />
      <SettingsRow
        icon="desktopcomputer"
        label="Environments"
        value={`${Object.keys(savedConnectionsById).length}`}
        valuePosition="trailing"
        target="SettingsEnvironments"
      />
      {children}
    </SettingsSection>
  );
}

function SettingsIndexSections() {
  const navigation = useNavigation();
  const { supported: goatBotHomeSupported } = useMobileGoatBotHomeSettings();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  return (
    <>
      <SettingsSection title="Interface">
        <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        {navigationCustomizationAvailable() ? (
          <SettingsRow
            icon="line.3.horizontal"
            label="Navigation tabs"
            target="SettingsNavigation"
          />
        ) : null}
        {Platform.OS === "ios" ? (
          <>
            <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
            <SettingsRow icon="mic" label="Microphone" target="SettingsMicrophone" />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Automations">
        {goatBotHomeSupported ? (
          <SettingsRow icon="text.bubble" label="GOAT Bot" target="SettingsGoatBot" />
        ) : null}
        <SettingsRow
          icon="questionmark.bubble"
          label="Decision inbox"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsDecisionInbox" },
            })
          }
        />
        <SettingsRow icon="clock" label="Scheduled tasks" target="SettingsScheduledTasks" />
      </SettingsSection>

      <SettingsSection title="Projects & threads">
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label="Overview"
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow icon="folder" label="Organization" target="SettingsOrganization" />
        <SettingsRow icon="text.bubble" label="Thread behavior" target="SettingsThreads" />
        <SettingsRow icon="arrow.turn.left.up" label="Follow-ups" target="SettingsFollowUp" />
        <SettingsRow icon="archivebox" label="Archived threads" target="SettingsArchive" />
      </SettingsSection>

      <SettingsSection title="Server settings">
        {selectedTargets.map((target) => (
          <MemoryEnvironmentEntry key={target.environmentId} environmentId={target.environmentId} />
        ))}
        <SettingsRow
          icon="person.crop.circle"
          label="Provider accounts"
          target="SettingsProviderAccounts"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.bubble"
          label="New threads"
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label="Source control"
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label="Agent behavior"
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label="Maintenance"
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow icon="info.circle" label="About GOAT" target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}

function OverflowSection() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const { layout } = useAdaptiveWorkspaceLayout();
  const tabs =
    Platform.OS === "android" && layout.usesSplitView ? [] : overflowNavigationTabs(order, hidden);
  const selectTab = useSelectWorkspaceTab();
  return tabs.length ? (
    <SettingsSection>
      {tabs.map((tab) => (
        <SettingsRow
          key={tab}
          icon={NAVIGATION_TAB_ICONS[tab]}
          label={WORKSPACE_TAB_LABELS[tab]}
          onPress={() => selectTab(tab)}
        />
      ))}
    </SettingsSection>
  ) : null;
}
