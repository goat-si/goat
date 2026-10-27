import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent, type ReactNode } from "react";
import { Platform } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { LoadingScreen } from "../../components/LoadingScreen";
import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { newTaskDestination } from "./new-task-project-selection";
import { ThreadScreenFallback } from "./ThreadScreenHost";

function ThreadRouteFallbackLayout(props: { readonly children: ReactNode }) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeVariables } = useAppearancePreferences();
  if (Platform.OS !== "android")
    return <ThreadScreenFallback>{props.children}</ThreadScreenFallback>;

  return (
    <>
      <AppBar
        title="Thread"
        options={{ contentStyle: { backgroundColor: themeVariables["--color-header"] } }}
        onBack={layout.usesSplitView ? undefined : goBack}
        hideBottomBorder
      />
      <ThreadScreenFallback>{props.children}</ThreadScreenFallback>
    </>
  );
}

export function OpeningThreadLoadingScreen() {
  return (
    <ThreadRouteFallbackLayout>
      <LoadingScreen
        message="Opening thread…"
        messagePlacement="above-spinner"
        embedded={Platform.OS === "android"}
      />
    </ThreadRouteFallbackLayout>
  );
}

export function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <ThreadRouteFallbackLayout>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1 android:bg-transparent"
      >
        <EmptyState
          title="Thread unavailable"
          detail="This thread is not available in the current mobile snapshot."
          actionLabel={props.actionLabel}
          onAction={props.onAction}
        />
      </ScrollView>
    </ThreadRouteFallbackLayout>
  );
}

/** A thread that can't load opens a new task in its environment instead of a dead end. */
export function UnavailableThreadDraftRedirect(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const { layout } = useAdaptiveWorkspaceLayout();
  const openDraft = useEffectEvent(() => {
    const project = projects.find((candidate) => candidate.environmentId === props.environmentId);
    navigation.dispatch(
      StackActions.replace(
        "Thread",
        newTaskDestination(layout.usesSplitView, projects, project, uuidv4()),
      ),
    );
  });
  // oxlint-disable-next-line goat/react-effect-budget -- replaces this route in the navigator
  useEffect(() => {
    openDraft();
  }, []);
  return <OpeningThreadLoadingScreen />;
}

