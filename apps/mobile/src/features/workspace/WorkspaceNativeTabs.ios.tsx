import {
  WORKSPACE_TAB_LABELS,
  NAVIGATION_TAB_ICONS,
  useEnabledNavigationTabs,
} from "./navigation-tabs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View, useWindowDimensions, type NativeSyntheticEvent } from "react-native";
import {
  Tabs,
  type TabSelectedEvent,
  type TabSelectionPreventedEvent,
  type TabSelectionRejectedEvent,
} from "react-native-screens";

import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import {
  NATIVE_WORKSPACE_TAB_SLOTS,
  workspaceTabForNativeSlot,
  workspaceUsesColumns,
  type WorkspaceTab,
} from "./workspace-tabs-state";
import {
  NativeWorkspaceTabActivityContext,
  WorkspaceSlotOptionsContext,
} from "../../native/v5-workspace-context";
import { useCompactWorkspaceTabs, useSystemWorkspaceTabBar } from "./useSystemWorkspaceTabBar";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useDeviceType } from "../../native/native-layout-metrics";
import { WorkspaceSidebarTabs } from "./WorkspaceSidebarTabs";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

type SlotWorkspace = NonNullable<ReturnType<typeof useWorkspaceTabs>>;
type TabDestination = WorkspaceTab | "settings";
type RenderTab = (workspace: SlotWorkspace, prewarming: boolean) => ReactNode;

const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

/** Retain each native controller tree; removing its root can leave RNS's stack empty. */
function RetainedWorkspaceTab(props: {
  readonly destination: TabDestination;
  readonly active: boolean;
  readonly prewarm: boolean;
  readonly ready: boolean;
  readonly identity: string;
  readonly setReady: (identity: string, ready: boolean) => void;
  readonly children: RenderTab;
}) {
  const workspace = useWorkspaceTabs()!;
  const { active, children, destination, identity, prewarm, ready, setReady } = props;
  const [content, setContent] = useState(
    active ? { source: workspace, workspace, children, prewarming: false } : null,
  );
  const stale = content?.source !== workspace || content.children !== children;
  if (active && (stale || content?.prewarming)) {
    setContent({ source: workspace, workspace, children, prewarming: false });
  } else if (!active && prewarm && (!content || (content.prewarming && stale))) {
    setContent({
      source: workspace,
      workspace: {
        ...workspace,
        settingsOpen: destination === "settings",
        state:
          destination === "settings"
            ? workspace.state
            : { ...workspace.state, selectedTab: destination },
      },
      children,
      prewarming: true,
    });
  }
  // Whether this slot is the visible one, read by cleanups after the switch has committed.
  const activeRef = useRef(props.active);
  useLayoutEffect(() => {
    activeRef.current = props.active;
  }, [props.active]);
  const isActive = useCallback(() => activeRef.current, []);
  const activity = useMemo(
    () => ({
      active,
      prewarming: content?.prewarming === true,
      isActive,
    }),
    [active, content?.prewarming, isActive],
  );
  const [optionsByRoute, setOptionsByRoute] = useState<ReadonlyMap<string, object>>(new Map());
  // Stable, so writers and the cleanups that depend on them don't re-run on every write.
  const setRouteOptions = useCallback(
    (routeKey: string, options: object) =>
      setOptionsByRoute((current) =>
        new Map(current).set(routeKey, { ...current.get(routeKey), ...options }),
      ),
    [],
  );
  const slotOptions = useMemo(
    () => ({ byRoute: optionsByRoute, set: setRouteOptions }),
    [optionsByRoute, setRouteOptions],
  );
  // oxlint-disable-next-line goat/react-effect-budget -- keeps the outgoing tab visible until native options settle
  useLayoutEffect(() => {
    if (!active || ready) return;
    const frame = requestAnimationFrame(() => setReady(identity, true));
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- new header options re-arm the frame
  }, [active, ready, identity, optionsByRoute, setReady]);

  // oxlint-disable-next-line goat/react-effect-budget -- a removed or reassigned slot must mount again
  useLayoutEffect(() => () => setReady(identity, false), [identity, setReady]);
  return content ? (
    <NativeWorkspaceTabActivityContext value={activity}>
      <WorkspaceSlotOptionsContext value={slotOptions}>
        <WorkspaceTabsContext value={content.workspace}>
          {content.children(content.workspace, content.prewarming)}
        </WorkspaceTabsContext>
      </WorkspaceSlotOptionsContext>
    </NativeWorkspaceTabActivityContext>
  ) : null;
}

export function WorkspaceNativeTabs(props: {
  readonly children: RenderTab;
  readonly hidden: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useEnabledNavigationTabs();
  const primaryTabs = order.slice(0, 4);
  const overflow = order[4];
  const selectTab = useSelectWorkspaceTab();
  const [provenance, setProvenance] = useState(0);
  const latestProvenance = useRef(-1);
  const acceptProvenance = (value: number) => {
    if (value < latestProvenance.current) return false;
    latestProvenance.current = value;
    setProvenance(value);
    return true;
  };
  const systemTabBar = useSystemWorkspaceTabBar();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const compactSidebarTabs = deviceType === "phone" || !layout.usesSplitView;
  const { width } = useWindowDimensions();
  const { colors } = useControlTheme();
  const selectedTab = workspace.state.selectedTab;
  const selectedSlot = workspace.settingsOpen ? -1 : primaryTabs.indexOf(selectedTab);
  const selectedScreenKey = NATIVE_WORKSPACE_TAB_SLOTS[selectedSlot] ?? "settings";
  const slots = NATIVE_WORKSPACE_TAB_SLOTS.flatMap((slot, index) => {
    const destination = slot === "settings" ? slot : primaryTabs[index];
    if (!destination) return [];
    const tab = destination === "settings" ? (overflow ?? selectedTab) : destination;
    return [{ slot, destination, tab, identity: `${slot}:${destination}` }];
  });
  const [readySlots, setReadySlots] = useState<ReadonlySet<string>>(() => new Set());
  const setReady = useCallback((identity: string, ready: boolean) => {
    setReadySlots((current) => {
      if (current.has(identity) === ready) return current;
      const next = new Set(current);
      if (ready) next.add(identity);
      else next.delete(identity);
      return next;
    });
  }, []);
  const selectedController = slots.find(({ slot }) => slot === selectedScreenKey);
  const [shownController, setShownController] = useState(selectedController);
  // A native slot can be reused by a different destination when a tab is enabled or disabled.
  const retainedController = slots.find(({ identity }) => identity === shownController?.identity);
  const visibleController =
    selectedController && readySlots.has(selectedController.identity)
      ? selectedController
      : (retainedController ?? selectedController);
  if (visibleController?.identity !== shownController?.identity) {
    setShownController(visibleController);
  }
  const visibleScreenKey = visibleController?.slot ?? selectedScreenKey;
  const request = { selectedScreenKey: visibleScreenKey, baseProvenance: provenance };
  const [prewarm, setPrewarm] = useState(false);
  const canPrewarm = layout.usesSplitView && readySlots.size > 0;
  // oxlint-disable-next-line goat/react-effect-budget -- prewarms hidden column pages after the visible tab settles
  useEffect(() => {
    if (!canPrewarm || prewarm) return;
    const idle = requestIdleCallback(() => setPrewarm(true), { timeout: 2_000 });
    return () => cancelIdleCallback(idle);
  }, [canPrewarm, prewarm]);
  return (
    <View style={{ flex: 1 }}>
      <Tabs.Host
        navStateRequest={request}
        tabBarHidden={props.hidden || !systemTabBar}
        ios={{
          tabBarControllerMode: "tabBar",
          tabBarMinimizeBehavior: "never",
          tabBarTintColor: colors["--color-primary"],
        }}
        onTabSelectionRejected={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionRejectedEvent>) =>
          acceptProvenance(nativeEvent.provenance)
        }
        onTabSelectionPrevented={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionPreventedEvent>) => {
          if (!acceptProvenance(nativeEvent.provenance)) return;
          const tab = workspaceTabForNativeSlot(primaryTabs, nativeEvent.preventedScreenKey);
          if (tab) selectTab(tab);
        }}
        onTabSelected={({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
          if (!acceptProvenance(nativeEvent.provenance)) return;
          if (nativeEvent.actionOrigin === "programmatic-js") return;
          const tab = workspaceTabForNativeSlot(primaryTabs, nativeEvent.selectedScreenKey);
          if (tab) selectTab(tab);
        }}
      >
        {slots.map(({ slot, destination, tab, identity }) => {
          const settings = destination === "settings";
          const ready = readySlots.has(identity);
          return (
            <Tabs.Screen
              // Stable slot controllers keep UIKit's stacks attached when a section moves into Settings.
              key={slot}
              screenKey={slot}
              preventNativeSelection={!ready && slot !== visibleScreenKey}
              title=""
              tabBarItemAccessibilityLabel={settings ? "Settings" : WORKSPACE_TAB_LABELS[tab]}
              ios={{
                icon: settings
                  ? { type: "sfSymbol", name: "gearshape" }
                  : tab === "pullRequests"
                    ? { type: "templateSource", templateSource: PULL_REQUEST_ICON }
                    : { type: "sfSymbol", name: NAVIGATION_TAB_ICONS[tab] },
                selectedIcon:
                  !settings && tab === "threads"
                    ? { type: "sfSymbol", name: "text.bubble.fill" }
                    : undefined,
                overrideScrollViewContentInsetAdjustmentBehavior: false,
              }}
            >
              <RetainedWorkspaceTab
                key={identity}
                destination={destination}
                identity={identity}
                active={slot === selectedScreenKey}
                prewarm={prewarm && layout.usesSplitView && destination !== "usage"}
                ready={ready}
                setReady={setReady}
              >
                {props.children}
              </RetainedWorkspaceTab>
            </Tabs.Screen>
          );
        })}
      </Tabs.Host>
      {(deviceType === "pad" ||
        compactTabs ||
        (layout.primarySidebarOverlaysContent &&
          !workspaceUsesColumns(selectedTab, workspace.settingsOpen))) &&
      !props.hidden ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 0,
            bottom: 0,
            width: layout.listPaneWidth ?? width,
            height: 128,
          }}
        >
          <WorkspaceSidebarTabs
            compact={compactSidebarTabs}
            reserveComposeSpace={compactSidebarTabs}
            onNewTask={
              compactSidebarTabs && !workspace.settingsOpen && selectedTab === "threads"
                ? startNewTask
                : undefined
            }
          />
        </View>
      ) : null}
    </View>
  );
}
