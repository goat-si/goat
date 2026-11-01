import { useMemo } from "react";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { useThreadHistoryMenu } from "./useThreadHistoryMenu";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenHeaderButton } from "../../components/ui/ScreenHeaderButton";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

export function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
  },
) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, panes, toggleAuxiliaryPane, composerKeyboardActive } =
    useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  const history = useThreadHistoryMenu(
    EnvironmentId.make(props.gitControls.environmentId),
    ThreadId.make(props.gitControls.threadId),
  );
  const historyActions = props.draft ? [] : history.actions;
  const historyMenu = {
    title: "Thread actions",
    icon: "ellipsis" as const,
    items: historyActions.map((action) => ({
      ...action,
      onPress: () => history.select(action.id),
    })),
  };
  const options = {
    ...native.options,
    unstable_headerRightItems: () => [
      ...native.rightHeaderItems,
      ...(historyActions.length
        ? [
            {
              accessibilityLabel: "Thread actions",
              icon: { name: "ellipsis", type: "sfSymbol" as const },
              identifier: "thread-actions",
              label: "Thread actions",
              menu: {
                title: "Thread actions",
                items: historyMenu.items.map((item) => ({
                  label: item.title,
                  onPress: item.onPress,
                  type: "action" as const,
                })),
              },
              type: "menu" as const,
            },
          ]
        : []),
    ],
  };
  const androidHeaderActions = useMemo<ReadonlyArray<AppBarAction>>(() => {
    const actions: AppBarAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    if (props.localWorkspaceAvailable !== false) {
      actions.push({
        accessibilityLabel: "Open git controls",
        icon: "point.topleft.down.curvedto.point.bottomright.up",
        onPress: props.onOpenGitInspector,
      });
    }
    if (props.localWorkspaceAvailable !== false && onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: PullRequestGlyph.merged,
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.localWorkspaceAvailable,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
    props.gitControls.canOpenTerminal,
  ]);

  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        options={options}
        optionsVersion={[native.optionsVersion, historyActions.length, history.select]}
        menus={historyActions.length ? [historyMenu] : []}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={layout.usesSplitView ? undefined : goBack}
        actions={androidHeaderActions}
        hideBottomBorder
        compact={composerKeyboardActive}
      />
      {native.fallback}
      {history.dialog}
    </>
  );
}
