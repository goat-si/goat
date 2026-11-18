import { Platform } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

export function FilesBrowserHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack: () => void;
}) {
  return (
    <AppBar
      title="Files"
      subtitle={props.projectName}
      onBack={props.onBack}
      hideBottomBorder
      matchSearchSurface
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: "Search files",
        closeAccessibilityLabel: "Close file search",
        clearAccessibilityLabel: "Clear file search",
      }}
      menus={
        Platform.OS === "android"
          ? [
              {
                title: "File options",
                icon: "ellipsis",
                items: [{ id: "refresh", title: "Refresh files", onPress: props.onRefresh }],
              },
            ]
          : undefined
      }
    />
  );
}

export function FileHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly iconColor: string;
  readonly activeMode: string;
  readonly fileInspectorSupported: boolean;
  readonly onBack: () => void;
  readonly onReturnToThread: () => void;
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly inline: boolean;
    readonly onPress: () => unknown;
  }>;
}) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const modes = props.actions.filter(({ inline }) => inline);
  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBack={props.onBack}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={
        props.fileInspectorSupported
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={
        props.fileInspectorSupported
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide file navigator"
                  : "Show file navigator",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        {
          title: "File actions",
          icon: "ellipsis",
          separateBackground: false,
          items: [
            ...(modes.length > 0
              ? [
                  {
                    id: "modes",
                    inline: true,
                    items: modes.map((action) => ({
                      ...action,
                      selected: action.id === props.activeMode,
                    })),
                  },
                ]
              : []),
            ...props.actions.filter(({ inline }) => !inline),
          ],
        },
      ]}
    />
  );
}
