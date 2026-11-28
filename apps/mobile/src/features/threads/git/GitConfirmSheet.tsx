import {
  resolveDefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
} from "@goat/client-runtime/state/vcs";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@goat/shared/git";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/ui/AndroidScreenHeader";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { vcsEnvironment } from "../../../state/vcs";
import { useReturnToThread } from "../thread-inspector-navigation";
import { GitActionFailure, SheetActionButton } from "./gitSheetComponents";

type GitConfirmSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly confirmAction?: string;
}>;

const CONFIRMABLE_ACTIONS: ReadonlyArray<DefaultBranchConfirmableAction> = [
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
];

export function GitConfirmSheet(props: GitConfirmSheetProps) {
  const navigation = useNavigation();
  const returnToThread = useReturnToThread();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  // The Git controls that opened this sheet already hold the checkout's status subscription.
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const terminology = sourceControlClients.get(
    selectedThreadProject?.repositoryIdentity?.provider,
  ).changeRequest;

  const params = props.route.params;

  // The route only names the action; what the sheet says about it comes from the checkout.
  const confirmAction = CONFIRMABLE_ACTIONS.find((action) => action === params.confirmAction);
  const branchName = gitStatus.data?.refName ?? null;
  const includesCommit = confirmAction === "commit_push" || confirmAction === "commit_push_pr";
  const environmentId = params.environmentId ?? "";
  const threadId = params.threadId ?? "";

  const copy = useMemo(
    () =>
      confirmAction && branchName
        ? resolveDefaultBranchActionDialogCopy({
            action: confirmAction,
            branchName,
            includesCommit,
            terminology,
          })
        : null,
    [branchName, confirmAction, includesCommit, terminology],
  );

  const continuePendingAction = useCallback(async () => {
    if (!canWriteSourceControl || !confirmAction || !copy) return;
    returnToThread({ environmentId, threadId });
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [
    canWriteSourceControl,
    confirmAction,
    copy,
    environmentId,
    gitActions,
    returnToThread,
    threadId,
  ]);

  const movePendingActionToFeatureBranch = useCallback(async () => {
    if (!canChangeThreadBranch || !confirmAction || !copy) return;
    returnToThread({ environmentId, threadId });

    if (includesCommit) {
      await gitActions.onRunSelectedThreadGitAction({ action: confirmAction, featureBranch: true });
      return;
    }

    const branches = await gitActions.refreshSelectedThreadBranches();
    if (branches === null) return;
    const newBranchName = resolveAutoFeatureBranchName(
      Arr.filterMap(branches, (branch) =>
        branch.isRemote ? Result.failVoid : Result.succeed(branch.name),
      ),
    );
    const created = await gitActions.onCreateSelectedThreadBranch(newBranchName);
    if (created === null) return;
    await gitActions.onRunSelectedThreadGitAction({ action: confirmAction });
  }, [
    canChangeThreadBranch,
    confirmAction,
    copy,
    gitActions,
    includesCommit,
    returnToThread,
    environmentId,
    threadId,
  ]);

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Confirm action"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <SheetHeader
            presentation="inline"
            title="Confirm action"
            accessibilityLabel="Close confirmation"
            onClose={() => navigation.goBack()}
          />
        </>
      )}

      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="android:gap-2 android:p-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 8 }
              : undefined
          }
        >
          <GitActionFailure />
          <View className="android:gap-2 android:rounded-[20px] android:bg-card android:p-3 ios:items-center ios:gap-1 ios:px-5 ios:pb-3 ios:pt-4">
            {Platform.OS !== "android" ? (
              <Text className="text-xs font-goat-bold tracking-[1px] uppercase text-foreground-muted">
                Confirm
              </Text>
            ) : null}
            <Text className="android:text-xl android:font-goat-medium ios:text-center ios:text-3xl ios:font-goat-bold">
              {copy?.title ?? "Run action on default branch?"}
            </Text>
            <Text className="text-foreground-secondary leading-normal android:text-base ios:text-center ios:text-sm ios:font-medium">
              {copy?.description ?? "Choose how to continue."}
            </Text>
          </View>

          <View
            className="android:gap-2 ios:gap-3 ios:px-5 ios:pt-2"
            style={
              Platform.OS === "android"
                ? undefined
                : { paddingBottom: Math.max(insets.bottom, 18) + 8 }
            }
          >
            <SheetActionButton
              icon="arrow.right.circle"
              label={copy?.continueLabel ?? "Continue"}
              disabled={!canWriteSourceControl || !copy}
              onPress={() => void continuePendingAction()}
            />
            <SheetActionButton
              icon="arrow.branch"
              label="Feature branch & continue"
              disabled={!canChangeThreadBranch || !copy}
              tone="primary"
              onPress={() => void movePendingActionToFeatureBranch()}
            />
          </View>
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
