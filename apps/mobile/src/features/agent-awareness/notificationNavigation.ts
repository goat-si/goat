import { RegistryContext } from "@effect/atom-react";
import { MAIN_BOT_ID } from "@goat/contracts";
import { type ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";
import { channelEnvironment } from "../../state/channels";
import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import { Atom } from "effect/reactivity";
import { resolveMobileBotAttentionLink } from "./goatBotAttentionLink";
import { startMobileBotAttention } from "./goatBotLocalAlerts";
import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { mobileGoatBotHomeEnvironmentIdAtom } from "../../state/goatBotHomeEnvironment";
import { useLinkTo, type NavigationState } from "@react-navigation/native";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

function screenTask(state: NavigationState): ReactNavigation.RootParamList["GoatBot"] | undefined {
  const route = state.routes[state.index];
  return route?.name === "GoatBot"
    ? (route.params as ReactNavigation.RootParamList["GoatBot"])
    : undefined;
}

export function useAgentNotificationNavigation(
  pathname: string,
  navigationState: NavigationState,
): void {
  const registry = useContext(RegistryContext);
  const activeTask = useRef(screenTask(navigationState));
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());
  const deepLinkOnScreen = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeTask.current = screenTask(navigationState);
    const thread = threadDeepLinkOnScreen(pathname);
    deepLinkOnScreen.current = thread;
    setAndroidThreadOnScreen(thread);
  }, [pathname, navigationState]);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: (notification) =>
        Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen.current)),
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);

  // oxlint-disable-next-line goat/react-effect-budget -- Keep one native alert reader per connected environment.
  useEffect(
    () =>
      startMobileBotAttention(registry, (target) => {
        const task = activeTask.current;
        const environmentId =
          task?.attentionEnvironment ?? registry.get(mobileGoatBotHomeEnvironmentIdAtom);
        return (
          environmentId === target.environmentId &&
          (task?.botId ?? MAIN_BOT_ID) === target.botId &&
          task?.taskId === target.taskId
        );
      }),
    [registry],
  );

  useEffect(() => {
    const lifetime = new AbortController();
    let currentTap: AbortController | null = null;
    const resolveBotTarget = async (target: ChannelAttentionTarget) => {
      currentTap?.abort();
      const tap = new AbortController();
      currentTap = tap;
      const signal = tap.signal;
      const ready = Atom.make((get) => {
        const catalog = get(environmentCatalog.catalogValueAtom);
        if (!catalog.isReady) return null;
        if (!catalog.entries.has(target.environmentId)) return false;
        const connection = get(
          environmentPresentations.presentationAtom(target.environmentId),
        )?.connection;
        if (connection?.phase === "connected") return true;
        return connection?.failure?.kind === "blocked" || connection?.phase === "unsupported"
          ? false
          : null;
      });
      // On cold start the pairing catalog and socket grant are loaded asynchronously.
      const connected = await new Promise<boolean>((resolve) => {
        const abort = () => resolve(false);
        const unsubscribe = registry.subscribe(
          ready,
          (value) => {
            if (value !== null) resolve(value);
          },
          { immediate: true },
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        signal.addEventListener("abort", unsubscribe, { once: true });
      });
      tap.abort();
      if (!connected || lifetime.signal.aborted) return null;
      const href = await resolveMobileBotAttentionLink(registry, channelEnvironment, target);
      return currentTap !== tap || lifetime.signal.aborted ? null : href;
    };
    const handleResponse = (response: Notifications.NotificationResponse) =>
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
        resolveBotTarget,
      });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void Promise.resolve()
        .then(() => handleResponse(response))
        .catch((cause) => console.warn("GOAT Bot could not open the alert", cause));
    });
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      lifetime.abort();
      currentTap?.abort();
      subscription.remove();
    };
  }, [linkTo, registry]);
}
