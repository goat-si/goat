import { ListRow } from "../../components/ui/ListRow";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import { diagnosePairingFailure, type PairingDiagnosis } from "@goat/client-runtime/connection";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import { FrostedCutout } from "../../components/ui/FrostedCutout";
import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import {
  setPendingConnectionError,
  useRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { SymbolView } from "../../components/ui/AppSymbol";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CloudEnvironmentRows } from "./CloudEnvironmentRows";
import { splitEnvironmentSections } from "./environmentSections";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectionController } from "./useConnectionController";
import {
  CONNECT_HUB_COPY,
  type ConnectHubIntent,
  finishHubPairing,
  resolveConnectHubIntent,
} from "./connectHubIntent";
import { selectHubEnvironmentId } from "./hubEnvironment";
import { useStoredHubEnvironment } from "./useStoredHubEnvironment";
import { useConnectionsReady } from "../../state/workspace";
import { PairingDiagnostics } from "./PairingDiagnostics";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
  readonly routeFor?: EnvironmentId;
  readonly intent?: "hub" | "change-hub" | "add-server";
  readonly replaceEnvironmentId?: EnvironmentId;
};

export function ConnectionsNewRouteScreen({
  route,
}: StaticScreenProps<ConnectionsNewRouteParams | undefined>) {
  const {
    connectedEnvironments,
    connectionPairingUrl,
    onChangeConnectionPairingUrl,
    onConnectPress,
    pairingConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const params = route.params ?? {};
  const controller = useConnectionController();
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const savedHub = useStoredHubEnvironment();
  const catalogReady = useConnectionsReady();
  const pairingReady = savedHub.loaded && catalogReady;
  const { localEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const resolvedIntent = resolveConnectHubIntent({
    ...params,
    savedEnvironmentCount: localEnvironments.length,
  });
  // Fixed once the saved environments are known, so a hub paired elsewhere while this sheet is
  // open cannot turn "Connect hub" into "Change hub" and remove that hub on the next success.
  const [openedIntent, setOpenedIntent] = useState<ConnectHubIntent | null>(null);
  if (pairingReady && openedIntent === null) setOpenedIntent(resolvedIntent);
  const intent = openedIntent ?? resolvedIntent;
  const copy = CONNECT_HUB_COPY[intent];
  const replaceEnvironmentId =
    params.replaceEnvironmentId ?? selectHubEnvironmentId(localEnvironments, savedHub.storedHubId);
  const replacedHubLabel =
    localEnvironments.find((environment) => environment.environmentId === replaceEnvironmentId)
      ?.environmentLabel ?? replaceEnvironmentId;
  // Deep-link prefill exists for development automation only. A production
  // link must not arrive with attacker-chosen host and token already filled.
  const routePairingUrl = __DEV__ ? (params.pairingUrl?.trim() ?? "") : "";
  const shouldAutoConnect =
    __DEV__ &&
    routePairingUrl.length > 0 &&
    (params.autoConnect === "1" || params.autoConnect === "true");
  const insets = useSafeAreaInsets();
  const [hostInput, setHostInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(
    Boolean(params.routeFor || routePairingUrl),
  );
  const [diagnosis, setDiagnosis] = useState<PairingDiagnosis | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const requestedCameraPermissionRef = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const screenFocused = useIsFocused();
  const [scannerLocked, setScannerLocked] = useState(false);
  // A good scan parks the camera so it can't re-read the code over later edits.
  const [scanComplete, setScanComplete] = useState(false);
  const attemptedAutoConnectRef = useRef<string | null>(null);

  const headerIconColor = useUniwindTheme()["--color-icon"];

  const connectDisabled = isSubmitting || !pairingReady || hostInput.trim().length === 0;
  const errorMessage = completionError ?? pairingConnectionError ?? savedHub.error;

  useEffect(() => {
    navigation.setOptions({ title: copy.title });
  }, [navigation, copy.title]);

  useEffect(() => {
    if (
      (intent === "hub" || intent === "change-hub") &&
      cameraPermission?.status === "undetermined" &&
      !requestedCameraPermissionRef.current
    ) {
      requestedCameraPermissionRef.current = true;
      void requestCameraPermission();
    }
  }, [intent, cameraPermission?.status, requestCameraPermission]);

  useEffect(() => {
    if (!connectionPairingUrl) return;
    const { host, code } = parsePairingUrl(connectionPairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [connectionPairingUrl]);

  useEffect(() => {
    if (routePairingUrl.length === 0) {
      return;
    }

    const { host, code } = parsePairingUrl(routePairingUrl);
    setHostInput(host);
    setCodeInput(code);
  }, [routePairingUrl]);

  const handleHostChange = (value: string) => {
    setHostInput(value);
    setPendingConnectionError(null);
    setDiagnosis(null);
    setCompletionError(null);
  };

  const handleCodeChange = (value: string) => {
    setCodeInput(value);
    setPendingConnectionError(null);
    setDiagnosis(null);
    setCompletionError(null);
  };

  useEffect(() => () => setPendingConnectionError(null), []);

  const handleScanPress = async () => {
    if (submittingRef.current || !pairingReady) return;
    setDiagnosis(null);
    setCompletionError(null);
    setPendingConnectionError(null);
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScanComplete(false);
      return;
    }
    if (permission.canAskAgain) return;
    Dialog.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const handleQrScan = ({ data }: { readonly data: string }) => {
    if (scannerLocked || scanComplete || submittingRef.current || !pairingReady) {
      return;
    }

    setScannerLocked(true);

    try {
      const pairingUrl = extractPairingUrlFromQrPayload(data);
      const { host, code } = parsePairingUrl(pairingUrl);
      setHostInput(host);
      setCodeInput(code);
      onChangeConnectionPairingUrl(pairingUrl);
      setScanComplete(true);
      setScannerLocked(false);
      void connectAndClose(pairingUrl);
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Dialog.alert(
        "Invalid QR code",
        error instanceof Error ? error.message : "Scanned QR code was not recognized.",
      );
      setTimeout(() => {
        setScannerLocked(false);
      }, 600);
    }
  };

  const connectAndClose = async (pairingUrl: string, manual = false) => {
    if (submittingRef.current || !pairingReady) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setDiagnosis(null);
    setCompletionError(null);
    onChangeConnectionPairingUrl(pairingUrl);
    try {
      const result = await onConnectPress(pairingUrl, params.routeFor);
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to pair with the environment.",
        );
        setDiagnosis(
          diagnosePairingFailure({
            host: parsePairingUrl(pairingUrl).host,
            error,
            networkStatus,
          }),
        );
        if (manual) setAdvancedExpanded(true);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;

      // Persist before removing the old hub so other saved servers cannot become the hub.
      await savedHub.rememberHubEnvironment({ intent, pairedEnvironmentId: result.value });
      const completion = await finishHubPairing({
        pairedEnvironmentId: result.value,
        intent,
        replaceEnvironmentId,
        removeEnvironment: controller.removeEnvironment,
      });
      if (completion.removalFailed) {
        setCompletionError(
          `Connected to the new hub, but couldn't remove ${replacedHubLabel}. Remove it from Environments.`,
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Return to whatever opened the sheet. Replacing it with Home would
      // nest Home inside any sheet still below it.
      if (!navigation.canGoBack()) {
        navigation.dispatch(StackActions.replace("Home"));
      } else {
        navigation.goBack();
      }
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : "Couldn't save the new hub.");
      if (manual) setAdvancedExpanded(true);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    await connectAndClose(buildPairingUrl(hostInput, codeInput), true);
  };

  useEffect(() => {
    if (
      !pairingReady ||
      !shouldAutoConnect ||
      attemptedAutoConnectRef.current === routePairingUrl
    ) {
      return;
    }

    attemptedAutoConnectRef.current = routePairingUrl;
    void connectAndClose(routePairingUrl);
  }, [connectAndClose, routePairingUrl, shouldAutoConnect, pairingReady]);

  return (
    <SettingsScreen
      formSheet={routeName === "ConnectionsNew" || routeName === "Pair"}
      title={copy.title}
      actions={
        advancedExpanded
          ? [
              {
                accessibilityLabel: isSubmitting ? "Connecting" : copy.title,
                loading: isSubmitting,
                icon: "checkmark",
                tintColor: headerIconColor,
                disabled: connectDisabled,
                onPress: () => {
                  void handleSubmit();
                },
              },
            ]
          : []
      }
    >
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 4,
        }}
      >
        <View collapsable={false} className="gap-6.5">
          <View collapsable={false} className="gap-2">
            <PairingScanCard
              disabled={isSubmitting || !pairingReady}
              cameraActive={
                cameraPermission?.granted === true &&
                screenFocused &&
                !scanComplete &&
                pairingReady &&
                !isSubmitting
              }
              onScan={handleQrScan}
              onScanPress={() => {
                void handleScanPress();
              }}
            />
            <Text className="px-4 text-sm leading-normal text-foreground-muted">
              {copy.scanHint}
            </Text>
            <Text className="px-4 text-sm leading-normal text-foreground-muted">
              Using your phone's camera opens this scanner. Scan once more inside the app.
            </Text>
          </View>

          {diagnosis ? (
            <PairingDiagnostics
              diagnosis={diagnosis}
              errorMessage={errorMessage ?? "Failed to pair with the environment."}
            />
          ) : null}
          {errorMessage ? (
            <Text
              accessibilityLiveRegion="polite"
              className="px-4 text-sm leading-normal text-danger-foreground"
            >
              {errorMessage}
            </Text>
          ) : null}

          <View collapsable={false} className="gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedExpanded }}
              onPress={() => setAdvancedExpanded((expanded) => !expanded)}
              className="min-h-13 flex-row items-center justify-between rounded-[26px] border-continuous bg-grouped-card px-4 active:opacity-70"
            >
              <Text className="text-base text-foreground">Advanced</Text>
              <SymbolView
                name={advancedExpanded ? "chevron.up" : "chevron.down"}
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </Pressable>
            {advancedExpanded ? (
              <>
                <Text className="px-4 text-sm font-goat-medium text-foreground-muted">
                  Enter address manually
                </Text>
                <View
                  collapsable={false}
                  className={cn(
                    "overflow-hidden rounded-[26px] border-continuous border bg-grouped-card",
                    pairingConnectionError ? "border-danger-foreground" : "border-transparent",
                  )}
                >
                  <PairingInputRow
                    label="Address"
                    keyboardType="url"
                    placeholder="192.168.1.100:3773"
                    value={hostInput}
                    onChangeText={handleHostChange}
                  />
                  <View className="ml-4 border-t border-border-subtle" />
                  <PairingInputRow
                    label="Code"
                    placeholder="Pairing code"
                    returnKeyType="go"
                    value={codeInput}
                    onChangeText={handleCodeChange}
                    onSubmitEditing={() => {
                      if (!connectDisabled) void handleSubmit();
                    }}
                  />
                </View>
                <Text className="px-4 text-sm leading-normal text-foreground-muted">
                  For machines on your local network or tailnet. The machine keeps its own provider
                  credentials.
                </Text>
              </>
            ) : null}
          </View>

          {hasCloudPublicConfig() ? <GoatConnectSection /> : null}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

const SCAN_CARD_HEIGHT = 250;
const SCAN_RETICLE_SIZE = 150;
const SCAN_RETICLE_TOP = 36;
const SCAN_RETICLE_RADIUS = 28;

function PairingScanCard(props: {
  readonly disabled: boolean;
  readonly cameraActive: boolean;
  readonly onScan: (result: { readonly data: string }) => void;
  readonly onScanPress: () => void;
}) {
  const light = useAppearancePreferences().themeAppearance === "light";
  return (
    <Pressable
      accessibilityRole={props.cameraActive ? undefined : "button"}
      accessibilityLabel={props.cameraActive ? undefined : "Scan QR code"}
      disabled={props.cameraActive || props.disabled}
      onPress={props.onScanPress}
      className={cn(
        "overflow-hidden rounded-[26px] border-continuous",
        light ? "bg-white" : "bg-black",
      )}
      style={{ height: SCAN_CARD_HEIGHT }}
    >
      <Svg accessibilityElementsHidden height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <RadialGradient id="pairing-scan-backdrop" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={light ? "#f4f4f5" : "#2e2e2e"} />
            <Stop offset="100%" stopColor={light ? "#d9d9dc" : "#0e0e0e"} />
          </RadialGradient>
        </Defs>
        <Rect fill="url(#pairing-scan-backdrop)" height="100%" width="100%" />
      </Svg>

      {props.cameraActive ? (
        <>
          <CameraView
            active
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={props.onScan}
            style={StyleSheet.absoluteFill}
          />
          <FrostedCutout
            cutoutTop={SCAN_RETICLE_TOP}
            cutoutWidth={SCAN_RETICLE_SIZE}
            cutoutHeight={SCAN_RETICLE_SIZE}
            cutoutRadius={SCAN_RETICLE_RADIUS}
            appearance={light ? "light" : "dark"}
          />
        </>
      ) : null}

      <View
        pointerEvents="none"
        className="absolute inset-x-0 items-center gap-3.5"
        style={{ top: SCAN_RETICLE_TOP }}
      >
        <View
          className={cn(
            "items-center justify-center gap-2 border-continuous border-[3px]",
            light ? "border-black/70" : "border-white/80",
          )}
          style={{
            borderRadius: SCAN_RETICLE_RADIUS,
            height: SCAN_RETICLE_SIZE,
            width: SCAN_RETICLE_SIZE,
          }}
        >
          {props.cameraActive ? null : (
            <>
              <SymbolView
                name="qrcode.viewfinder"
                size={44}
                tintColorClassName={light ? "accent-black/60" : "accent-white/70"}
                type="monochrome"
                weight="light"
              />
              <Text
                className={cn(
                  "font-goat-medium text-sm",
                  light ? "text-black/70" : "text-white/80",
                )}
              >
                Tap to scan
              </Text>
            </>
          )}
        </View>
        <Text className={cn("text-center text-sm", light ? "text-black/70" : "text-white/80")}>
          Scan QR code
        </Text>
      </View>
    </Pressable>
  );
}

function GoatConnectSection() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const { connectedEnvironments, onSetEnvironmentEnabled, onRemoveEnvironmentPress } =
    useRemoteConnections();
  const { connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });

  return (
    <View collapsable={false} className="gap-2">
      <Text className="px-4 text-sm font-goat-medium text-foreground-muted">
        Or use the managed relay
      </Text>
      {isSignedIn ? (
        <CloudEnvironmentRows
          connectedCloudEnvironments={connectedCloudEnvironments}
          onSetEnvironmentEnabled={onSetEnvironmentEnabled}
          onRemoveEnvironment={onRemoveEnvironmentPress}
          showHeader={false}
        />
      ) : (
        <ListRow
          label="Sign in to GOAT Connect"
          description="Reach your machines from anywhere, no network setup."
          disabled={!isLoaded}
          onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
        />
      )}
    </View>
  );
}

function PairingInputRow({
  label,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
}) {
  return (
    <View collapsable={false} className="h-13 flex-row items-center gap-3 px-4">
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="w-20 text-base leading-[23px] text-foreground-muted"
      >
        {label}
      </Text>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base leading-[23px]"
      />
    </View>
  );
}
