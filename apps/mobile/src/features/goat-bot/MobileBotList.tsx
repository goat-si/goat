import { useNavigationState } from "@react-navigation/native";
import { View } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { MobileBotRoster } from "./MobileBotRosterPanel";
import { MobileHomeSegments } from "./MobileBotRosterView";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

export function MobileHomeModeSegments() {
  const home = useMobileGoatBotHomeMode();
  return home.known ? <MobileHomeSegments mode={home.mode} onSelect={home.setMode} /> : null;
}

export function MobileBotList({ showSegments = true }: { readonly showSegments?: boolean }) {
  const selectDetail = useSelectWorkspaceDetail();
  const selectedKey = useNavigationState((state) => {
    const route = state.routes[state.index];
    if (route?.name !== "GoatBot") return null;
    const params = route.params as { taskId?: string } | undefined;
    return params?.taskId ? `task:${params.taskId}` : null;
  });
  return (
    <View className="flex-1 bg-screen">
      <MobileBotRoster
        header={showSegments ? <MobileHomeModeSegments /> : null}
        selectedKey={selectedKey}
        onOpenBot={() => selectDetail({ name: "GoatBot", params: {} })}
        onOpenChild={(row) => {
          if (row.kind === "task")
            selectDetail({ name: "GoatBot", params: { taskId: row.task.taskId } });
          else
            selectDetail({
              name: "Thread",
              params: { environmentId: String(row.environmentId), threadId: String(row.threadId) },
            });
        }}
      />
    </View>
  );
}
