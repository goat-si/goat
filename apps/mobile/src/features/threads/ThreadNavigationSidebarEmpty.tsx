import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { WorkspaceConnectionState } from "../../state/workspaceModel";

/** What the sidebar's thread list says when it has no rows. */
export function ThreadNavigationSidebarEmpty(props: {
  readonly catalogState: WorkspaceConnectionState;
  readonly searchQuery: string;
  readonly searchPending: boolean;
  readonly projectScopeTitle: string | null;
  readonly onOpenEnvironmentSettings: () => void;
}) {
  const { catalogState } = props;
  const showAddEnvironment =
    !catalogState.isLoadingConnections &&
    !catalogState.hasReadyEnvironment &&
    !catalogState.hasConnectingEnvironment;
  return (
    <View>
      <Text
        className={
          Platform.OS === "android"
            ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
            : "px-2 py-4 text-sm text-drawer-foreground-muted"
        }
      >
        {catalogState.isLoadingConnections
          ? "Loading threads…"
          : showAddEnvironment
            ? "No environments connected"
            : props.searchQuery.trim().length > 0
              ? props.searchPending
                ? "Searching thread messages…"
                : "No matching threads"
              : props.projectScopeTitle !== null
                ? `No threads in ${props.projectScopeTitle}`
                : "No threads yet"}
      </Text>
      {showAddEnvironment ? (
        <View className={Platform.OS === "android" ? "self-center" : "px-2"}>
          <Button
            tone="primary"
            icon="plus"
            label="Add environment"
            onPress={props.onOpenEnvironmentSettings}
          />
        </View>
      ) : null}
    </View>
  );
}
