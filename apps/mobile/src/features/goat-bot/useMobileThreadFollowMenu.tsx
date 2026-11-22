import { RegistryContext } from "@effect/atom-react";
import { chooseThreadFollow, threadFollowSupported } from "@goat/client-runtime/goatBot";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@goat/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, Modal, ScrollView, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";

type Picker = {
  title: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  resolve: (id: string | null) => void;
};

export function useMobileThreadFollowMenu(thread: ScopedThreadRef) {
  const { environmentId, threadId } = thread;
  const registry = useContext(RegistryContext);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const available =
    canOperate &&
    presentation?.connection.phase === "connected" &&
    threadFollowSupported(
      thread,
      presentation.serverConfig?.environment.capabilities?.goatBotThreadFollows,
    );
  const [picker, setPicker] = useState<Picker | null>(null);
  const pending = useRef<Picker | null>(null);
  const identity = available ? JSON.stringify([environmentId, threadId]) : null;
  const activeRun = useRef<{ controller: AbortController; identity: string } | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Cancel an outstanding picker when its thread or permission changes.
  useEffect(
    () => () => {
      if (activeRun.current?.identity !== identity) return;
      activeRun.current.controller.abort();
      pending.current?.resolve(null);
      pending.current = null;
      setPicker(null);
    },
    [identity],
  );
  const select = useCallback(
    (id: string) => {
      if (!identity || activeRun.current) return;
      const run = { controller: new AbortController(), identity };
      activeRun.current = run;
      void chooseThreadFollow(
        registry,
        channelEnvironment,
        { environmentId, threadId },
        id === "bot-follow" ? "follow" : "stop",
        (title, choices) =>
          run.controller.signal.aborted
            ? Promise.resolve(null)
            : new Promise((resolve) => {
                const next = { title, choices, resolve };
                pending.current = next;
                setPicker(next);
              }),
        (message) => {
          if (!run.controller.signal.aborted) Alert.alert(message);
        },
        run.controller.signal,
      ).finally(() => {
        if (activeRun.current === run) activeRun.current = null;
      });
    },
    [identity, environmentId, registry, threadId],
  );
  const choose = (id: string | null) => {
    if (pending.current !== picker) return;
    pending.current = null;
    setPicker(null);
    picker?.resolve(id);
  };

  return {
    actions: available
      ? [
          { id: "bot-follow", title: "Ask a bot to follow…" },
          { id: "bot-stop-following", title: "Stop following" },
        ]
      : [],
    select,
    dialog:
      available && picker ? (
        <Modal visible transparent onRequestClose={() => choose(null)}>
          <View className="flex-1 items-center justify-center bg-backdrop px-6">
            <View className="max-h-[80%] w-full max-w-md gap-3 rounded-3xl bg-screen p-5">
              <AppText accessibilityRole="header">{picker.title}</AppText>
              <ScrollView>
                {picker.choices.map((choice) => (
                  <Button key={choice.id} label={choice.label} onPress={() => choose(choice.id)} />
                ))}
              </ScrollView>
              <Button label="Cancel" onPress={() => choose(null)} />
            </View>
          </View>
        </Modal>
      ) : null,
  };
}
