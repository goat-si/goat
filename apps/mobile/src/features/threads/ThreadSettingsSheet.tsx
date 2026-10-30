import { getProviderOptionCurrentValue } from "@goat/shared/model";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { createContext, use, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { withRememberedModelOptions } from "../../state/use-model-option-memory";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { ThreadSettingsCatalogScreen } from "./ThreadSettingsCatalog";
import { ThreadSettingsOverview } from "./ThreadSettingsOverview";
import { ChoiceRow } from "./ThreadSettingsRows";
import { selectableChoices } from "./thread-settings-options";
import {
  ThreadSettingsSessionProvider,
  useThreadSettingsSession,
  type ThreadSettingsSessionProps,
  type ThreadSettingsSubmenuPage,
} from "./thread-settings-session";

const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);

export type ExistingThreadSettingsRouteSession = ThreadSettingsSessionProps & {
  readonly ownerId: string;
};

type ExistingThreadSettingsRouteContextValue = {
  readonly session: ExistingThreadSettingsRouteSession | null;
  readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ExistingThreadSettingsRouteContext =
  createContext<ExistingThreadSettingsRouteContextValue | null>(null);

export function ExistingThreadSettingsRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ExistingThreadSettingsRouteSession | null>(null);
  const present = (nextSession: ExistingThreadSettingsRouteSession) => {
    setSession(nextSession);
  };
  const clear = (ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  };
  const value = { session, present, clear };

  return (
    <ExistingThreadSettingsRouteContext.Provider value={value}>
      {props.children}
    </ExistingThreadSettingsRouteContext.Provider>
  );
}

export function useExistingThreadSettingsRoutePresentation() {
  const value = use(ExistingThreadSettingsRouteContext);
  if (!value) {
    throw new Error(
      "useExistingThreadSettingsRoutePresentation must be used inside ExistingThreadSettingsRouteProvider.",
    );
  }
  return value;
}

function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              selected:
                choice.id ===
                (session.promptTraits.ultrathinkPromptControlled &&
                activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "ultrathink"
                  : getProviderOptionCurrentValue(
                      activeDescriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )),
              onPress: () => {
                void Haptics.selectionAsync();
                if (
                  session.promptTraits.ultrathinkInBodyText &&
                  activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                ) {
                  Dialog.alert(
                    "Reasoning controlled by prompt",
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  );
                  return;
                }
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsCatalog: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const openSubmenu = (submenu: ThreadSettingsSubmenuPage) => {
    const title =
      submenu.kind === "runtime"
        ? "Runtime"
        : (session.displayedDescriptors.find(
            (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
          )?.label ?? "Option");
    navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
  };
  const openCatalog = () => {
    // The catalog's search field starts empty on every visit, so the query must too.
    session.setSearchQuery("");
    navigation.navigate("ThreadSettingsCatalog");
  };

  return (
    <>
      {Platform.OS === "android" ? (
        <SheetHeader
          onCancel={presentation.onClose}
          title="Thread settings"
          confirm={session.pendingModel ? { label: "Save", onPress: commitAndClose } : undefined}
        />
      ) : null}
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      <ScreenContent>
        <ThreadSettingsOverview onOpenCatalog={openCatalog} onOpenSubmenu={openSubmenu} />
      </ScreenContent>
      {Platform.OS === "ios" ? (
        <SheetHeader
          title="Thread settings"
          onCancel={presentation.onClose}
          accessibilityLabel="Cancel thread settings"
          confirm={{
            label: session.pendingModel ? "Save thread settings" : "Done",
            onPress: commitAndClose,
          }}
        />
      ) : null}
    </>
  );
}

function ThreadSettingsCatalogRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const back = () => navigation.goBack();
  return <ThreadSettingsCatalogScreen onBack={back} onPicked={back} />;
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <ScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </ScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: Platform.OS === "android" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShown: Platform.OS !== "android",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Thread settings" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsCatalog"
          component={ThreadSettingsCatalogRouteScreen}
          options={{ title: "All models" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerNavigator onClose={props.onClose} />
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const { ownerId: _ownerId, ...settings } = session;

  return <ThreadSettingsPickerScreen {...settings} onClose={() => navigation.goBack()} />;
}

/** RNS owns nested sheet dismissal; Reasoning and Runtime remain ordinary pushes. */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = resolveProviderOptionDescriptors({
    capabilities: flow.selectedModelOption?.capabilities,
    selections: flow.selectedModel?.options,
  });

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}
