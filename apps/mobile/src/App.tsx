import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installPermissionUpdateNotice } from "./features/connection/permissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { requireNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Platform, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  createStaticNavigation,
  getActionFromState,
  getStateFromPath,
} from "@react-navigation/native";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { followKeptPerComputerCatalog } from "./features/goat-bot/useKeptPerComputer";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells, threadEnvironment } from "./state/threads";
import { environmentShell, shellCachesReadAtom } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import {
  shouldHandleAppLink,
  restoreDraftLinkState,
  withoutPairingTarget,
  pairingFormLinkAction,
} from "./lib/appLinking";
import { APP_SCHEMES } from "@goat/shared/mobileAppIdentity";
import { hasCloudPublicConfig } from "./features/cloud/publicConfig";
import { takeScheduledTaskNewLink } from "./features/settings/scheduled-task-editor-state";
import {
  disposeOnFoundationReplace,
  type FoundationHotModule,
} from "./lib/foundation-fast-refresh";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import {
  restoreSettingsLinkState,
  settingsLinkAction,
} from "./features/settings/settings-navigation";
import {
  hydrateWorkspaceSelections,
  launchWorkspaceURL,
  recordWorkspaceSelections,
  settingsLinkPage,
} from "./features/workspace/workspace-selection-store";
import { workspaceDetailLinkAction } from "./features/workspace/workspace-detail-selection";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";

import { attachRootNavigation, rootNavigationRef as navigationRef } from "./lib/rootNavigation";
import { pruneNewTaskFlowStates } from "./features/threads/new-task-flow-state";
import { pruneNewTaskBranchCheckouts } from "./features/threads/NewTaskDraftRouteScreen";
import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});
void hydrateWorkspaceSelections();

const appLinking = {
  prefixes: [Linking.createURL("/"), ...APP_SCHEMES.map((scheme) => `${scheme}://`)],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  filter: (url: string) => shouldHandleAppLink(url, hasCloudPublicConfig()),
  getInitialURL: async () => (await Linking.getInitialURL()) ?? (await launchWorkspaceURL()),
  getActionFromState: (
    state: Parameters<typeof getActionFromState>[0],
    options: Parameters<typeof getActionFromState>[1],
  ): ReturnType<typeof getActionFromState> => {
    const current = navigationRef.isReady() ? navigationRef.getRootState() : undefined;
    return (
      // Our router handles the selection; React Navigation's type only lists its own actions.
      (workspaceDetailLinkAction(state) as ReturnType<typeof getActionFromState>) ??
      pairingFormLinkAction(state, current) ??
      settingsLinkAction(state, current) ??
      getActionFromState(state, options)
    );
  },
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    takeScheduledTaskNewLink(
      restoreSettingsLinkState(
        restoreDraftLinkState(withoutPairingTarget(getStateFromPath(path, options)), path),
        settingsLinkPage(),
      ),
    ),
};

const Navigation = createStaticNavigation(RootStack);

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const appServiceDisposers = [
  installPermissionUpdateNotice(),
  installThreadOutboxDelivery(),
  installComposerAttachmentUploads(),
  followKeptPerComputerCatalog(appAtomRegistry),
];
disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () => {
  for (const dispose of appServiceDisposers) dispose();
});

// Cached shells are local reads that end in a fraction of this time; the limit only keeps a
// failed read from holding the splash screen.
const SPLASH_SHELL_CACHE_WAIT_MS = 1_500;

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const shellCachesRead = useAtomValue(shellCachesReadAtom);
  const [waitEnded, setWaitEnded] = useState(false);

  // oxlint-disable-next-line goat/react-effect-budget -- bounds how long the native splash screen waits for cached shells
  useEffect(() => {
    const timer = setTimeout(() => setWaitEnded(true), SPLASH_SHELL_CACHE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // The thread list paints every environment's cached rows at once when the splash hides
  // after they are read.
  const canHide = isReady && (shellCachesRead || waitEnded);
  useEffect(() => {
    if (canHide) void SplashScreen.hide();
  }, [canHide]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
        pendingThreadIdsAtom: threadEnvironment.pendingThreadIdsAtom,
      }),
    [],
  );

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  // oxlint-disable-next-line goat/react-effect-budget -- synchronize the Android navigation bar with the app theme
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void requireNativeModule<{ setNavigationBarStyle(light: boolean): Promise<void> }>(
      "GoatNativeControls",
    ).setNavigationBarStyle(themeAppearance === "light");
  }, [themeAppearance]);

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* native-stack needs the theme's dark flag to select dark native headers. */}
              <GlobalVoiceInputControl>
                <NativeLayoutMetricsProvider>
                  <IncomingShareProvider>
                    <Navigation
                      ref={attachRootNavigation}
                      linking={appLinking}
                      onReady={() => {
                        const state = navigationRef.getRootState();
                        recordWorkspaceSelections(state);
                        if (state) {
                          pruneNewTaskFlowStates(state);
                          pruneNewTaskBranchCheckouts(state);
                        }
                      }}
                      theme={navigationTheme}
                      onStateChange={(state) => {
                        recordWorkspaceSelections(state);
                        if (state) {
                          pruneNewTaskFlowStates(state);
                          pruneNewTaskBranchCheckouts(state);
                        }
                      }}
                    />
                  </IncomingShareProvider>
                  <Dialog.Host />
                  <ThreadArrangementHost />
                  <ProjectChipIconRasterizer />
                </NativeLayoutMetricsProvider>
              </GlobalVoiceInputControl>
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
