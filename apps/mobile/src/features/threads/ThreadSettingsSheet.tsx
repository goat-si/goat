import { StackActions, useNavigation } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { Platform, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { ThreadSettingsTraits } from "./ThreadSettingsTraits";
import {
  ThreadSettingsSessionProvider,
  type ThreadSettingsSessionProps,
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

type RootNavigation = NativeStackNavigationProp<Record<string, object | undefined>>;

// The last measured popover height, so a reopened sheet starts at its size instead of resizing.
let lastPopoverHeight = 320;

/**
 * The composer's reasoning popover; its "fitToContents" sheet sizes to this content.
 * On iOS, react-native-screens wraps a sheet's content in a flex:1 SafeAreaView, which collapses
 * to zero height inside the content-sized wrapper, so the sheet would measure nothing. The popover
 * measures its own content and gives that wrapper an explicit height through `contentStyle`.
 */
function ThreadSettingsPopover(
  props: ThreadSettingsSessionProps & { readonly onOpenModelPicker: () => void },
) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [contentHeight, setContentHeight] = useState(lastPopoverHeight);
  const sheetHeight = Math.round(Math.min(contentHeight, height * 0.9));
  return (
    <ThreadSettingsSessionProvider {...props}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{ contentStyle: { height: sheetHeight } }}
          optionsVersion={sheetHeight}
        />
      ) : null}
      <ScreenContent fitToContents>
        <ScrollView
          className="bg-sheet ios:flex-1"
          style={Platform.OS === "android" ? { flexGrow: 0, maxHeight: height * 0.85 } : undefined}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) }}
          onContentSizeChange={(_width, nextHeight) => {
            lastPopoverHeight = nextHeight;
            setContentHeight(nextHeight);
          }}
          showsVerticalScrollIndicator={false}
        >
          <ThreadSettingsTraits onOpenModelPicker={props.onOpenModelPicker} />
        </ScrollView>
      </ScreenContent>
    </ThreadSettingsSessionProvider>
  );
}

function ThreadModelPicker(props: ThreadSettingsSessionProps & { readonly onClose: () => void }) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsCatalogScreen
        onClose={props.onClose}
        onBack={props.onClose}
        onPicked={props.onClose}
      />
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<RootNavigation>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="bg-sheet" />;
  }

  const { ownerId: _ownerId, ...settings } = session;

  return (
    <ThreadSettingsPopover
      {...settings}
      onOpenModelPicker={() => navigation.dispatch(StackActions.push("ThreadModelPicker"))}
    />
  );
}

export function ExistingThreadModelPickerRouteScreen() {
  const navigation = useNavigation<RootNavigation>();
  const session = useExistingThreadSettingsRoutePresentation().session;
  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }
  const { ownerId: _ownerId, ...settings } = session;
  return <ThreadModelPicker {...settings} onClose={() => navigation.goBack()} />;
}

function useNewTaskSettingsSession(): ThreadSettingsSessionProps {
  const flow = useNewTaskFlow();
  return {
    environmentId: flow.selectedEnvironmentId,
    projectId: flow.selectedProject?.id ?? null,
    ...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {}),
    providerGroups: flow.providerGroups,
    selectedModel: flow.selectedModel,
    prompt: flow.prompt,
    onPromptChange: flow.setPrompt,
    onSelectModel: (option) => flow.setSelectedModelKey(option.key, option.selection.options),
    restoreSelection: withRememberedModelOptions,
    optionDescriptors: resolveProviderOptionDescriptors({
      capabilities: flow.selectedModelOption?.capabilities,
      selections: flow.selectedModel?.options,
    }),
    onUpdateOptionSelections: flow.setSelectedModelOptions,
    runtimeMode: flow.runtimeMode,
    onUpdateRuntimeMode: flow.setRuntimeMode,
  };
}

export function NewTaskThreadSettingsRouteScreen() {
  const navigation = useNavigation<RootNavigation>();
  const session = useNewTaskSettingsSession();
  return (
    <ThreadSettingsPopover
      {...session}
      onOpenModelPicker={() => navigation.dispatch(StackActions.push("NewTaskModelPicker"))}
    />
  );
}

export function NewTaskModelPickerRouteScreen() {
  const navigation = useNavigation<RootNavigation>();
  const session = useNewTaskSettingsSession();
  return <ThreadModelPicker {...session} onClose={() => navigation.goBack()} />;
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsTraits: undefined;
  ThreadSettingsModels: undefined;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerCloseContext = createContext<(() => void) | null>(null);

function ThreadSettingsTraitsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const onClose = use(ThreadSettingsPickerCloseContext);
  const close = () => onClose?.();
  return (
    <>
      {Platform.OS === "android" ? <SheetHeader title="Model" onClose={close} /> : null}
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      <ScreenContent>
        <ScrollView
          className="flex-1 bg-sheet"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
        >
          <ThreadSettingsTraits
            onOpenModelPicker={() => navigation.navigate("ThreadSettingsModels")}
          />
        </ScrollView>
      </ScreenContent>
      {Platform.OS === "ios" ? <SheetHeader title="Model" onClose={close} /> : null}
    </>
  );
}

function ThreadSettingsModelsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const back = () => navigation.goBack();
  return <ThreadSettingsCatalogScreen onBack={back} onPicked={back} />;
}

/** The same controls as the composer popover, as a full sheet with the catalog pushed inside. */
export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];

  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerCloseContext.Provider value={props.onClose}>
        <ThreadSettingsPickerStack.Navigator
          initialRouteName="ThreadSettingsTraits"
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
            name="ThreadSettingsTraits"
            component={ThreadSettingsTraitsScreen}
            options={{ headerBackVisible: false, title: "Model" }}
          />
          <ThreadSettingsPickerStack.Screen
            name="ThreadSettingsModels"
            component={ThreadSettingsModelsScreen}
            options={{ title: "Models" }}
          />
        </ThreadSettingsPickerStack.Navigator>
      </ThreadSettingsPickerCloseContext.Provider>
    </ThreadSettingsSessionProvider>
  );
}
