import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { BRAND_CHANNEL_LABEL } from "@goat/shared/brandChannels";
import { settlePromise } from "@goat/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { resolveMobileBrandChannel } from "../../lib/mobileBranding";
import { useDeadlinePassed } from "../../lib/clock";
import { I18nProvider, useGT } from "../../i18n/I18nProvider";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  isAppUpdatePending,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  return (
    <I18nProvider>
      <AboutScreen />
    </I18nProvider>
  );
}

function AboutScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="About GOAT">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const gt = useGT();
  const [checkState, setCheckState] = useState<{
    readonly state: AppUpdateCheckState;
    // "Up to date" is a confirmation that fades back to idle.
    readonly settledUntil: number | null;
  }>(() => ({ state: isAppUpdatePending() ? "ready" : "idle", settledUntil: null }));
  const confirmationExpired = useDeadlinePassed(checkState.settledUntil);
  const updateState =
    checkState.state === "current" && confirmationExpired ? "idle" : checkState.state;
  const updateInFlight = useRef(false);
  const betaChannel = Platform.select({
    ios: { label: "TestFlight", url: "https://testflight.apple.com/join/4PXeSgXv" },
    android: {
      label: "Firebase App Distribution",
      url: "https://appdistribution.firebase.dev/i/b6f930a2e01c9f53",
    },
  });

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Match app.config.ts's production fallback to avoid mislabeling builds as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = BRAND_CHANNEL_LABEL[resolveMobileBrandChannel(variant)];
  const build = Application.nativeBuildVersion;
  const installedVersion = build ? `${version} (${build})` : version;
  const versionLabel = variantLabel ? `${installedVersion} · ${variantLabel}` : installedVersion;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  async function checkForUpdate(install = false) {
    // disabled updates next render; the ref blocks same-frame double taps.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    // Failures arrive through onFailure; the settled result only matters for unlocking.
    await settlePromise(() =>
      runAppUpdateCheck({
        applyMode: install ? "immediate" : "manual",
        onFailure: (message) => Dialog.alert(gt("Update failed"), message),
        onStateChange: (state) =>
          setCheckState({
            state,
            settledUntil: state === "current" ? Date.now() + 3000 : null,
          }),
      }),
    );
    updateInFlight.current = false;
  }

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnostics" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {versionRow}
      {updateCheckAvailable ? (
        <SettingsRow
          icon="arrow.clockwise"
          label={gt("Check for app updates")}
          disabled={busy}
          onPress={() => void checkForUpdate()}
        />
      ) : null}
      {updateCheckAvailable && updateState === "ready" ? (
        <SettingsRow
          icon="arrow.down.circle"
          label={gt("Install app update")}
          disabled={busy}
          onPress={() => void checkForUpdate(true)}
        />
      ) : null}
      {Application.applicationId === "si.goat.mobile" && betaChannel ? (
        <SettingsRow
          icon="arrow.up.right"
          label={gt("Check beta builds")}
          value={betaChannel.label}
          onPress={() =>
            void Linking.openURL(betaChannel.url).catch(() =>
              Dialog.alert(gt("Could not open beta builds"), betaChannel.url),
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
