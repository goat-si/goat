import {
  allowsGoatBotAlert,
  attentionCursorKey,
  goatBotAttentionTitle,
  watchGoatBotAttention,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { type ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { Atom, AsyncResult, type AtomRegistry } from "effect/reactivity";

import { secureStore } from "../../persistence/namespaced-secure-store";
import { channelEnvironment } from "../../state/channels";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { postAndroidLocalAlert } from "./androidNotifications";

export function startMobileBotAttention(
  registry: AtomRegistry.AtomRegistry,
  focused: (target: ChannelAttentionTarget) => boolean,
) {
  const watches = new Map<EnvironmentId, () => void>();
  const watch = (environmentId: EnvironmentId) => {
    // Secure Store only accepts a restricted alphabet.
    const key = attentionCursorKey(environmentId).replaceAll("_", "_5F").replaceAll("%", "_");
    const enabled = Atom.make(
      (get) =>
        get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
          .capabilities.goatBotAttention === true &&
        get(channelEnvironment.listBotAttention.permissionAtom(environmentId)),
    );
    let stop = () => {};
    const unsubscribe = registry.subscribe(
      enabled,
      (active) => {
        stop();
        stop = active
          ? watchGoatBotAttention({
              registry,
              channels: channelEnvironment,
              environmentId,
              onError: (cause) => console.warn("GOAT Bot could not deliver an alert", cause),
              readCursor: async () => {
                const saved = await secureStore.getItem(key);
                const value = saved === null ? NaN : Number(saved);
                return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
              },
              writeCursor: (value) => secureStore.setItem(key, String(value)),
              present: async (event, mode, active) => {
                if (!allowsGoatBotAlert(mode, event)) return;
                const preferences = registry.get(mobilePreferencesAtom);
                if (
                  !AsyncResult.isSuccess(preferences) ||
                  preferences.value.goatBotLocalAlerts === false
                )
                  return;
                if (!(await Notifications.getPermissionsAsync()).granted || !active()) return;
                if (AppState.currentState === "active" && focused(event)) return;
                const data = {
                  kind: "goat-bot-attention",
                  environmentId,
                  taskId: event.taskId,
                  botId: event.botId,
                  generation: event.generation,
                  ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
                };
                const identifier = `${environmentId}:${event.eventId}`;
                const title = goatBotAttentionTitle(event);
                if (Platform.OS === "android" && postAndroidLocalAlert(identifier, title, data))
                  return;
                await Notifications.scheduleNotificationAsync({
                  identifier,
                  content: { title, data },
                  trigger: null,
                });
              },
            })
          : () => {};
      },
      { immediate: true },
    );
    return () => {
      unsubscribe();
      stop();
    };
  };
  const releasePreferences = registry.mount(mobilePreferencesAtom);
  const unsubscribe = registry.subscribe(
    connectedEnvironmentIdsAtom,
    (ids) => {
      for (const [id, stop] of watches) {
        if (!ids.includes(id)) {
          stop();
          watches.delete(id);
        }
      }
      for (const id of ids) {
        if (!watches.has(id)) watches.set(id, watch(id));
      }
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    releasePreferences();
    for (const stop of watches.values()) stop();
    watches.clear();
  };
}
