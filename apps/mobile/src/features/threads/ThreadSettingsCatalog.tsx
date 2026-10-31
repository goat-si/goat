import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { formatProviderUpdateRequiredNotice } from "@goat/client-runtime/providerUpdateRequiredModels";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, RefreshControl, TextInput, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { ModelOption } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import { ModelRow } from "./ThreadSettingsRows";
import {
  FAVORITES_PROVIDER_FILTER,
  useThreadSettingsSession,
  type ThreadSettingsSessionValue,
} from "./thread-settings-session";
import {
  favoritesFirst,
  modelMatchesCatalogQuery,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";

const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);
/** Keep measured size changes stable; let catalog mutations return underflowing filtered lists to the top. */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);

function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      <Text className="text-sm font-goat-medium text-foreground-muted">{props.label}</Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-goat-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-11 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60 android:min-h-12"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    };

function ThreadSettingsModelListRow(props: {
  readonly option: ModelOption;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onPicked: () => void;
}) {
  const session = useThreadSettingsSession();
  const onPress = () => {
    if (session.selectModel(props.option)) props.onPicked();
  };

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      isFavorite={session.favoriteKeys.has(props.option.key)}
      favoritesLoaded={session.favoritesLoaded}
      onToggleFavorite={() => session.toggleFavorite(props.option)}
      onToggleHidden={
        session.manageHidden && props.option.canHide
          ? () => session.toggleHidden(props.option)
          : undefined
      }
      hiddenUpdatePending={session.pendingHiddenKeys.has(props.option.key)}
      option={props.option}
      selected={session.isApplied(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = () => session.toggleProvider(props.provider.key);

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      iconUrl={props.provider.iconUrl}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function buildThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  return session.providerGroups.flatMap((group) => {
    if (
      session.providerFilter !== null &&
      session.providerFilter !== FAVORITES_PROVIDER_FILTER &&
      group.providerKey !== session.providerFilter
    ) {
      return [];
    }
    const driver = group.models[0]?.providerDriver ?? group.providerKey;
    const catalogModels =
      session.manageHidden ||
      session.showLegacy ||
      session.providerFilter === FAVORITES_PROVIDER_FILTER
        ? group.models
        : group.models.filter(
            (model) =>
              !model.isLegacy || session.isApplied(model) || session.favoriteKeys.has(model.key),
          );
    const visibleModels = favoritesFirst(
      catalogModels.filter(
        (model) =>
          (session.providerFilter !== FAVORITES_PROVIDER_FILTER ||
            session.favoriteKeys.has(model.key)) &&
          modelMatchesCatalogQuery({
            model,
            providerLabel: group.providerLabel,
            query: session.searchQuery,
          }),
      ),
      session.favoriteKeys,
    );
    const updateRequiredNotice =
      group.updateRequired && session.providerFilter !== FAVORITES_PROVIDER_FILTER
        ? formatProviderUpdateRequiredNotice(group.updateRequired, session.searchQuery)
        : null;
    if (visibleModels.length === 0 && !updateRequiredNotice) {
      return [];
    }
    const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
    const containsAppliedSelection = group.models.some(session.isApplied);
    const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
    const collapsible = !isNarrowed;
    const collapsed = providerSectionIsCollapsed({
      defaultExpanded: isPrimary || containsAppliedSelection,
      hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
      isNarrowed,
    });
    const provider: ThreadSettingsProviderCatalog = {
      key: group.providerKey,
      driver,
      iconUrl: group.models[0]?.providerIconUrl,
      label: group.providerLabel,
      collapsible,
      collapsed,
      modelCount: visibleModels.length,
      models: collapsed ? [] : visibleModels,
    };
    return [
      {
        kind: "provider" as const,
        key: `provider:${group.providerKey}`,
        provider,
      },
      ...provider.models.map((option, index) => ({
        kind: "model" as const,
        key: `model:${option.key}`,
        option,
        isFirst: index === 0,
        isLast: index === provider.models.length - 1,
      })),
      ...(!collapsed && updateRequiredNotice
        ? [
            {
              kind: "notice" as const,
              key: `notice:${group.providerKey}`,
              text: updateRequiredNotice,
            },
          ]
        : []),
    ];
  });
}

function ThreadSettingsCatalogList(props: { readonly onPicked: () => void }) {
  const insets = useSafeAreaInsets();
  // The keyboard covers the list's bottom, and on iOS the search toolbar rides above it.
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const session = useThreadSettingsSession();
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void refreshProviderCatalog(session.environmentId).then((result) => {
      setIsRefreshingProviders(false);
      const error = providerCatalogRefreshError(result);
      if (error) Dialog.alert("Could not refresh models", error);
    });
  };
  const [listLoaded, setListLoaded] = useState(false);
  const reducedMotion = useReducedMotion();
  const animationsReady = listLoaded && !reducedMotion;
  const catalogItems = buildThreadSettingsCatalogItems(session);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems: ReadonlyArray<ThreadSettingsCatalogItem> =
    catalogItems.length === 0 ? [{ kind: "empty", key: "empty" }] : catalogItems;
  // Both iOS search layouts float a bottom toolbar over the list's last rows.
  const bottomToolbarInset = Platform.OS === "ios" ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET : 0;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "provider") {
      content = <ThreadSettingsProviderListHeader provider={item.provider} />;
    } else if (item.kind === "model") {
      content = (
        <ThreadSettingsModelListRow
          isFirst={item.isFirst}
          isLast={item.isLast}
          onPicked={props.onPicked}
          option={item.option}
        />
      );
    } else if (item.kind === "notice") {
      content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
    } else {
      content = (
        <View className="items-center px-8 py-14">
          <Text className="text-center text-sm text-foreground-muted">
            {session.providerFilter === FAVORITES_PROVIDER_FILTER &&
            session.searchQuery.trim().length === 0
              ? "No favorite models"
              : hasActiveCatalogFilter
                ? "No matching models"
                : "No available models"}
          </Text>
        </View>
      );
    }

    return (
      <Animated.View
        key={item.key}
        entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
        exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
      >
        {content}
      </Animated.View>
    );
  };

  return (
    // oxlint-disable-next-line goat/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling.
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={Platform.OS === "android" ? 56 : 48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      // iOS keeps the keyboard up while scrolling so the footer inset can reach the last rows;
      // the search field's cancel button closes it.
      keyboardDismissMode={Platform.OS === "ios" ? "none" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListFooterComponent={
        <View
          style={{ height: Math.max(insets.bottom, keyboardHeight) + bottomToolbarInset + 12 }}
        />
      }
      ListHeaderComponent={
        <>
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <View
                className="flex-row items-center rounded-full bg-input px-2"
                style={{ minHeight: 56 }}
              >
                <View pointerEvents="none" className="px-2">
                  <SymbolView
                    name="magnifyingglass"
                    size={24}
                    tintColorClassName="accent-icon-subtle"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Find a model"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                  style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                  onChangeText={session.setSearchQuery}
                  placeholder="Find a model"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  cursorColorClassName="accent-focus"
                  selectionHandleColorClassName="accent-focus"
                  value={session.searchQuery}
                />
                {session.searchQuery.length > 0 ? (
                  <IconButton
                    accessibilityLabel="Clear model search"
                    icon="xmark"
                    onPress={() => session.setSearchQuery("")}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </>
      }
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl refreshing={isRefreshingProviders} onRefresh={refreshProviders} />
        ) : undefined
      }
      onLoad={() => setListLoaded(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

// With a Duo vertical bar, filter and search join cancel and confirm in the rail.
function useThreadSettingsMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return useNativeMailSearchToolbar() && (metrics?.verticalBarEdge ?? "none") === "none";
}

export function ThreadSettingsCatalogScreen(props: {
  /** Present when the catalog is its own sheet rather than a pushed page. */
  readonly onClose?: () => void;
  readonly onBack: () => void;
  readonly onPicked: () => void;
}) {
  const session = useThreadSettingsSession();
  const usesNativeMailSearchToolbar = useThreadSettingsMailSearchToolbar();
  const hasCustomCatalogFilter =
    session.providerFilter !== null || session.showLegacy || session.manageHidden;
  const providerFilters = [
    { id: "all-providers", title: "All providers", value: null },
    { id: "favorites", title: "Favorites", value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];
  const toggles = [
    ...(session.hasLegacyModels
      ? [
          {
            id: "show-legacy",
            title: "Show legacy models",
            isOn: session.showLegacy,
            toggle: () => session.setShowLegacy(!session.showLegacy),
          },
        ]
      : []),
    {
      id: "manage-hidden",
      title: "Manage hidden models",
      isOn: session.manageHidden,
      toggle: () => session.setManageHidden(!session.manageHidden),
    },
  ];
  const filterMenu = {
    title: "Model filters",
    items: [
      {
        type: "submenu" as const,
        title: "Provider",
        items: providerFilters.map((filter) => ({
          type: "action" as const,
          title: filter.title,
          state: session.providerFilter === filter.value ? ("on" as const) : ("off" as const),
          onPress: () => session.setProviderFilter(filter.value),
        })),
      },
      ...toggles.map((item) => ({
        type: "action" as const,
        title: item.title,
        state: item.isOn ? ("on" as const) : ("off" as const),
        onPress: item.toggle,
      })),
    ],
  };

  return (
    <>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Models"
          onBack={props.onBack}
          hideBottomBorder
          trailing={
            <AndroidAnchoredMenu
              title="Model filters"
              actions={[
                {
                  title: "Provider",
                  subactions: providerFilters.map((filter) => ({
                    id: filter.id,
                    title: filter.title,
                    state: session.providerFilter === filter.value ? "on" : "off",
                  })),
                },
                ...toggles.map((item) => ({
                  id: item.id,
                  title: item.title,
                  state: item.isOn ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) => {
                const toggle = toggles.find((item) => item.id === nativeEvent.event);
                if (toggle) {
                  toggle.toggle();
                  return;
                }
                const filter = providerFilters.find((item) => item.id === nativeEvent.event);
                if (filter) session.setProviderFilter(filter.value);
              }}
            >
              {(open) => (
                <IconButton
                  accessibilityLabel="Filter models"
                  icon="line.3.horizontal.decrease"
                  selected={hasCustomCatalogFilter}
                  variant={hasCustomCatalogFilter ? "tonal" : "standard"}
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          }
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
          session.manageHidden,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ScreenContent>
        <ThreadSettingsCatalogList onPicked={props.onPicked} />
      </ScreenContent>
      {Platform.OS === "ios" && props.onClose ? (
        <SheetHeader presentation="native" title="Models" onClose={props.onClose} />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Model filters"
          >
            <Toolbar.Menu title="Provider">
              <Toolbar.Label>Provider</Toolbar.Label>
              {providerFilters.map((filter) => (
                <Toolbar.MenuAction
                  key={filter.id}
                  isOn={session.providerFilter === filter.value}
                  onPress={() => session.setProviderFilter(filter.value)}
                >
                  {filter.title}
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>
            {toggles.map((item) => (
              <Toolbar.MenuAction key={item.id} isOn={item.isOn} onPress={item.toggle}>
                {item.title}
              </Toolbar.MenuAction>
            ))}
          </Toolbar.Menu>
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
    </>
  );
}
