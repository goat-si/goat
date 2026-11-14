import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  dismissCreatedBot,
  dismissNewBot,
  forgetNewBotIntentsOf,
  goatBotName,
  newBotSlot,
  retryNewBot,
  settleListedNewBots,
  startNewBot,
  subscribeNewBots,
  type BotRosterEntry,
  type CreateNewBot,
  type OpenIfStillHere,
} from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelTaskId } from "@goat/contracts";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { Alert, type AlertButton, AppState, Pressable, Text, View } from "react-native";
import { uuidv4 } from "../../lib/uuid";
import { MobileBotEditSheet } from "./MobileBotEditSheet";
import { MobileBotRosterView } from "./MobileBotRosterView";
import { MobileNewBotStatus } from "./MobileNewBotStatus";
import { useMobileBotRoster } from "./useMobileBotRoster";
import { useMobileBotPreview } from "./useMobileBotPreview";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileBotManage } from "./useMobileBotManage";

export function MobileBotRoster(props: {
  header?: ReactNode;
  selectedKey: string | null;
  onOpenBot: (bot: BotRosterEntry) => void;
  onOpenTask?: (bot: BotRosterEntry, taskId: ChannelTaskId) => void;
  visible?: boolean;
}) {
  const roster = useMobileBotRoster();
  const preview = useMobileBotPreview(useMobileGoatBotHomeMode().botRef);
  const mainName = goatBotName(roster.groups.main);
  const manage = useMobileBotManage(roster.environmentId, mainName);
  const [editing, setEditing] = useState<BotProfile | null>(null);
  // A row's action menu is a native alert: open from the long press until a choice or dismissal.
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = (
    title: string,
    message: string | undefined,
    buttons: ReadonlyArray<AlertButton>,
  ) => {
    setMenuOpen(true);
    Alert.alert(
      title,
      message,
      buttons.map((button) => ({
        ...button,
        onPress: () => {
          setMenuOpen(false);
          button.onPress?.();
        },
      })),
      { cancelable: true, onDismiss: () => setMenuOpen(false) },
    );
  };
  const environmentId = roster.environmentId;
  const slot = useSyncExternalStore(subscribeNewBots, () => newBotSlot(environmentId));
  const operation = slot.operation;
  const create: CreateNewBot = (name, clientRequestId) =>
    manage.create({ name, avatar: null, purpose: "" }, null, clientRequestId);
  const { onOpenBot } = props;
  const navigation = useNavigation();
  // This roster mount as it is now: mounted, on screen, presenting a sheet or menu of its own, and
  // its environment. A create's answer reads it then; the open belongs to the mount that was tapped.
  const visible = props.visible !== false;
  const presenting = editing !== null || menuOpen;
  const mount = useRef({ mounted: true, visible, presenting, environmentId });
  // oxlint-disable-next-line goat/react-effect-budget -- A create answers later; it must read this mount's committed state.
  useLayoutEffect(() => {
    mount.current = { mounted: true, visible, presenting, environmentId };
  }, [visible, presenting, environmentId]);
  // oxlint-disable-next-line goat/react-effect-budget -- An unmounted roster (the Bots / Threads switch) opens nothing when its create answers.
  useEffect(() => {
    const owner = mount;
    return () => {
      owner.current = { ...owner.current, mounted: false };
      forgetNewBotIntentsOf(owner);
    };
  }, []);
  // The new chat opens only if, when the create answers: the app is in front; this roster is still
  // mounted, on screen and presenting nothing of its own; the focused route at every level reads as
  // at the tap; and the roster still shows the environment the create was sent to. Read then.
  const openIfStillHere = (): OpenIfStillHere => {
    const tapped = whereNow(navigation);
    return (bot, sentTo) => {
      const now = mount.current;
      if (
        AppState.currentState === "active" &&
        now.mounted &&
        now.visible &&
        !now.presenting &&
        whereNow(navigation) === tapped &&
        now.environmentId === sentTo
      )
        onOpenBot({ kind: "member", profile: bot });
    };
  };
  const listed = roster.listedBots;
  const refreshBots = roster.refreshBots;
  const refreshedFor = useRef(new Set<string>());
  const created = slot.created;
  // oxlint-disable-next-line goat/react-effect-budget -- A created bot's own row arrives with the next list read; until then its row here stands in.
  useEffect(() => {
    if (environmentId === null || listed === null || created.length === 0) return;
    const ids = new Set(listed.map((bot) => bot.botId));
    settleListedNewBots(environmentId, ids);
    // One list read per created bot; a read that fails or still lacks it leaves the row and the list's error.
    const unlisted = created.filter(
      (bot) => !ids.has(bot.botId) && !refreshedFor.current.has(bot.botId),
    );
    if (unlisted.length === 0 || refreshBots === null) return;
    for (const bot of unlisted) refreshedFor.current.add(bot.botId);
    refreshBots();
  }, [environmentId, listed, created, refreshBots]);
  const askAbout = (entry: BotRosterEntry) => {
    const bot = entry.profile;
    if (bot === null) return;
    const edit = { text: "Edit", onPress: () => setEditing(bot) };
    const cancel = { text: "Cancel", style: "cancel" as const };
    if (entry.kind === "main") {
      if (manage.canEdit) menu(bot.name, undefined, [edit, cancel]);
      return;
    }
    if (!manage.canManage) return;
    menu(bot.name, undefined, [
      ...(manage.canEdit ? [edit] : []),
      {
        text: bot.hidden === true ? "Show" : "Hide",
        onPress: () => void manage.hide(bot, bot.hidden !== true),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          menu(`Delete ${bot.name}?`, "Its conversation is archived; you can restore it.", [
            cancel,
            { text: "Delete", style: "destructive", onPress: () => void manage.remove(bot) },
          ]),
      },
      cancel,
    ]);
  };
  return (
    <View className="flex-1">
      <MobileBotRosterView
        header={
          <>
            {props.header}
            {roster.error ? (
              <View className="flex-row items-center gap-2 px-4">
                <Text className="flex-1 text-danger-foreground">{roster.error}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={roster.retryBots}
                  className="min-h-[44px] min-w-[44px] justify-center px-2"
                >
                  <Text className="font-goat-medium text-primary-text">Retry</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        }
        selectedKey={props.selectedKey}
        bots={roster.bots}
        members={
          roster.supportsMembers
            ? {
                hidden: roster.groups.hidden,
                deleted: roster.groups.deleted,
                // The generated name needs the whole list, hidden and deleted included.
                canCreate: manage.canCreate && listed !== null && operation === null,
                onNewBot: () => {
                  if (environmentId !== null && listed !== null)
                    startNewBot(environmentId, listed, create, openIfStillHere(), mount, uuidv4);
                },
                onLongPressBot: askAbout,
                canRestore: manage.canManage,
                onRestoreDeleted: (bot) =>
                  menu(`Restore ${bot.name}?`, "Its conversation comes back.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Restore", onPress: () => void manage.restore(bot) },
                  ]),
              }
            : undefined
        }
        slackEnabled={roster.slackEnabled}
        preview={preview?.text}
        unread={preview?.unread}
        mainEnvironmentId={environmentId}
        onOpenBot={props.onOpenBot}
        onOpenTask={props.onOpenTask}
        onUnknownBot={roster.refreshBots ?? undefined}
        visible={props.visible}
        newBotRow={
          environmentId !== null && (operation !== null || created.length > 0) ? (
            <MobileNewBotStatus
              operation={operation}
              created={created}
              onRetry={() => retryNewBot(environmentId, create, openIfStillHere(), mount)}
              onDismiss={() => dismissNewBot(environmentId)}
              onOpen={(bot) => onOpenBot({ kind: "member", profile: bot })}
              onDismissCreated={(bot) => dismissCreatedBot(environmentId, bot.botId)}
            />
          ) : null
        }
      />
      {editing !== null && environmentId !== null ? (
        <MobileBotEditSheet
          key={editing.botId}
          bot={editing}
          environmentId={environmentId}
          manage={manage}
          mainName={mainName}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </View>
  );
}

type Navigation = Omit<NavigationProp<ParamListBase>, "getParent"> & {
  getParent: () => Navigation | undefined;
};
type Route = { readonly key: string; readonly params?: object; readonly state?: State };
type State = { readonly index?: number; readonly routes: ReadonlyArray<Route> };

/** The focused route at every level, with its params. */
function whereNow(navigation: ReturnType<typeof useNavigation>): string {
  let root = navigation as unknown as Navigation;
  for (let parent = root.getParent(); parent !== undefined; parent = parent.getParent())
    root = parent;
  const focused: Array<[string, object | null]> = [];
  let state: State | undefined = root.getState() as State;
  while (state !== undefined) {
    const route: Route | undefined = state.routes[state.index ?? 0];
    if (route === undefined) break;
    focused.push([route.key, route.params ?? null]);
    state = route.state;
  }
  return JSON.stringify(focused);
}
