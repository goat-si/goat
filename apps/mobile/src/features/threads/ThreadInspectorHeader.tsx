import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { View } from "react-native";
import { IconButton } from "../../components/ui/IconButton";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ThreadInspectorHistory } from "./useThreadHistoryMenu";

export interface ThreadInspectorPresentation {
  readonly onClose: () => void;
  readonly onMaximize?: () => void;
}

export function ThreadInspectorHeader(
  props: ThreadInspectorPresentation & {
    readonly title: string;
    readonly environmentId: EnvironmentId | null;
    readonly threadId: ThreadId | null;
  },
) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: true, headerTransparent: true }} />
      <SheetHeader
        title={props.title}
        onClose={props.onClose}
        accessibilityLabel="Close thread preview"
        trailing={
          <View className="flex-row items-center">
            {props.environmentId && props.threadId ? (
              <ThreadInspectorHistory
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}
            {props.onMaximize ? (
              <IconButton
                icon="arrow.up.left.and.arrow.down.right"
                accessibilityLabel="Maximize thread"
                onPress={props.onMaximize}
              />
            ) : null}
          </View>
        }
      />
    </>
  );
}
