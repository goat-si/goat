import { useAtomValue } from "@effect/atom-react";
import { createComputerUseHistoryCommand } from "@goat/client-runtime/state/computer-use-history";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useCallback, useState, type ReactNode } from "react";
import { Modal, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { AppText } from "../../components/ui/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { ThreadComputerUseHistory } from "./ThreadComputerUseHistory";

const command = createComputerUseHistoryCommand(connectionAtomRuntime);

export function useThreadHistoryMenu(environmentId: EnvironmentId, threadId: ThreadId) {
  const canRead = useAtomValue(command.permissionAtom(environmentId));
  const [opened, setOpened] = useState<string | null>(null);
  const identity = `${environmentId}:${threadId}`;
  const select = useCallback(
    (id: string) => {
      if (id === "input-history" && canRead) setOpened(identity);
    },
    [canRead, identity],
  );
  const close = () => setOpened(null);
  return {
    actions: canRead ? [{ id: "input-history", title: "Input history", image: "clock" }] : [],
    select,
    dialog:
      opened === identity && canRead ? (
        <Modal visible transparent animationType="fade" onRequestClose={close}>
          <View className="flex-1 items-center justify-center bg-backdrop px-6">
            <View className="w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
              <AppText accessibilityRole="header" className="text-xl font-goat-semibold">
                Input history
              </AppText>
              <ThreadComputerUseHistory environmentId={environmentId} threadId={threadId} />
              <Button label="Close" onPress={close} />
            </View>
          </View>
        </Modal>
      ) : null,
  };
}

export function ThreadHistoryReadOnly(props: {
  readonly history: ReturnType<typeof useThreadHistoryMenu>;
  readonly children: ReactNode;
}) {
  if (props.history.actions.length === 0) return props.children;
  return (
    <>
      {props.history.dialog}
      <Menu
        actions={props.history.actions}
        onPressAction={({ nativeEvent }) => props.history.select(nativeEvent.event)}
        shouldOpenOnLongPress
      >
        {props.children}
      </Menu>
    </>
  );
}
