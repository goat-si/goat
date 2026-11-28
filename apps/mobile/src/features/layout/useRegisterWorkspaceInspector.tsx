import { NavigationContext, NavigationRouteContext } from "@react-navigation/native";
import { use, useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";
import { WorkspaceVisibleRouteContext } from "./workspace-presentation-context";

/** Capture inspector navigation contexts. Register on focus events because frozen blurred screens may never clean up. */
export function useRegisterWorkspaceInspector(render: (() => ReactNode) | undefined) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);
  const visibleWorkspaceRoute = use(WorkspaceVisibleRouteContext);

  const wrappedRender = (() => {
    if (render === undefined) {
      return undefined;
    }
    return () => (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{render()}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  })();

  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  const syncRegistration = useEffectEvent(() => {
    if (!focusedRef.current || wrappedRender === undefined) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(wrappedRender);
  });
  // An overlay (a maximized thread, a sheet) blurs the route but leaves it the visible workspace
  // page, so the column stays registered and the sidebar doesn't shift behind the overlay.
  const handleBlur = useEffectEvent(() => {
    if (route !== undefined && visibleWorkspaceRoute === route.key) return;
    focusedRef.current = false;
    syncRegistration();
  });

  // oxlint-disable-next-line goat/react-effect-budget -- Navigation focus events own the inspector registration lifetime.
  useEffect(() => {
    if (!navigation) return;
    const focus = () => {
      focusedRef.current = true;
      syncRegistration();
    };
    if (navigation.isFocused()) focus();
    const unsubscribeFocus = navigation.addListener("focus", focus);
    const unsubscribeBlur = navigation.addListener("blur", handleBlur);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);

  // oxlint-disable-next-line goat/react-effect-budget -- Synchronize the focused inspector registration with its current content.
  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Changed pane content replaces its existing native workspace registration.
  }, [wrappedRender]);

  // oxlint-disable-next-line goat/react-effect-budget -- Remove the native inspector registration when its owner unmounts.
  useEffect(
    () => () => {
      deactivateRef.current?.();
      deactivateRef.current = null;
    },
    [],
  );
}
