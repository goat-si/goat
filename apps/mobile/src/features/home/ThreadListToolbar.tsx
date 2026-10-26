import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  BackHandler,
  Keyboard,
  type TextInputInstance,
  View,
  Text,
  type LayoutChangeEvent,
} from "react-native";
import type { MenuAction } from "@react-native-menu/menu";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import { useMobileGoatBotModeButton } from "../goat-bot/useMobileGoatBotHomeMode";
import { useMobileGoatBotModelMenu } from "../goat-bot/useMobileGoatBotModel";
import { GoatBotModelAndroidMenu } from "../goat-bot/GoatBotModelAndroidMenu";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceConnectionState } from "../../state/workspace";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";

export function ThreadListToolbar(props: {
  readonly homeMode?: "thread" | "bot";
  readonly botKnown?: boolean;
  readonly onToggleHomeMode?: () => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const botMode = useMobileGoatBotModeButton();
  const mode = props.homeMode ?? botMode.mode;
  const botKnown = props.botKnown ?? botMode.known;
  const toggleMode = props.onToggleHomeMode ?? botMode.toggle;
  const compactBot = mode === "bot" && !props.sidebar;
  const botModel = useMobileGoatBotModelMenu();
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const { height, paddingTop, paddingBottom } = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  const filterIcon = props.filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const searchField = (
    <SearchField
      inputRef={searchRef}
      accessibilityLabel="Search threads"
      clearAccessibilityLabel="Clear search"
      placeholder="Search"
      value={props.searchQuery}
      onChangeText={onSearchQueryChange}
    />
  );
  const filterButton = connectionState.hasConnections ? (
    <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Filter threads"
          icon={filterIcon}
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  ) : null;

  const goatControls = (
    <>
      {compactBot && botModel ? <GoatBotModelAndroidMenu menu={botModel} /> : null}
      {botKnown ? (
        <AndroidHeaderIconButton
          accessibilityLabel={
            mode === "bot" && !botMode.threadOpen ? "Show threads" : "Show GOAT Bot"
          }
          icon={mode === "bot" && !botMode.threadOpen ? "text.alignleft" : "text.bubble"}
          onPress={toggleMode}
        />
      ) : null}
      <AndroidHeaderIconButton
        accessibilityLabel="Open notes"
        icon="doc.text"
        onPress={() => navigation.navigate("Notes")}
      />
    </>
  );

  return (
    <View
      onLayout={props.onLayout}
      className={props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"}
      style={{ paddingTop, paddingBottom }}
    >
      {compactBot ? (
        <View className="flex-row items-center gap-1" style={{ minHeight: height }}>
          <View className="min-w-0 flex-1 pl-4">
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironments}
              brand={<Text className="text-xl font-semibold text-foreground">GOAT Bot</Text>}
            />
          </View>
          {goatControls}
        </View>
      ) : (
        <WorkspaceListToolbarRow
          searching={searching}
          searchField={searchField}
          onCloseSearch={closeSearch}
          onOpenSearch={openSearch}
          searchAccessibilityLabel="Search threads"
          titleAccessibilityLabel="GOAT, Threads"
          onOpenEnvironments={props.onOpenEnvironments}
          filter={
            <>
              {filterButton}
              {!searching ? goatControls : null}
            </>
          }
        />
      )}
    </View>
  );
}
