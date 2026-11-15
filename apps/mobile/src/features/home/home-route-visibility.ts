import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Atom } from "effect/reactivity";

/**
 * Fabric never freezes the route below focus; Home must stop its own work beneath Thread.
 * `runWhenCovered` runs an action once the page opening over Home covers it; Home starting
 * to reappear first drops it.
 */
export function useHomeRouteVisibility(): {
  readonly visible: boolean;
  readonly runWhenCovered: (action: () => void) => void;
} {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();
  // A cold deep link mounts Home under its Thread without ever showing it.
  const [visible, setVisible] = useState(() => navigation.isFocused());
  const onCovered = useRef<(() => void) | null>(null);
  useEffect(() => {
    const show = () => setVisible(true);
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      if (data.closing) return;
      onCovered.current = null;
      show();
    });
    // Each iOS tab slot shows its own copy of the Home route, and the slot a tab switch leaves
    // disappears last. So a disappear hides Home only when another route has the focus.
    const removeTransitionEnd = navigation.addListener("transitionEnd", ({ data }) => {
      if (!data.closing || navigation.isFocused()) return;
      setVisible(false);
      const action = onCovered.current;
      onCovered.current = null;
      action?.();
    });
    // Popping a sheet or a deep-linked route above Home has no appear event.
    const removeFocus = navigation.addListener("focus", show);
    return () => {
      removeTransitionStart();
      removeTransitionEnd();
      removeFocus();
    };
  }, [navigation]);
  const runWhenCovered = useCallback((action: () => void) => {
    onCovered.current = action;
  }, []);
  return { visible, runWhenCovered };
}

export function useAtomValueWhileVisible<A>(atom: Atom.Atom<A>, visible: boolean): A {
  const registry = useContext(RegistryContext);
  const held = useRef<{ readonly value: A } | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => (visible ? registry.subscribe(atom, onChange) : () => undefined),
    [registry, atom, visible],
  );
  return useSyncExternalStore(subscribe, () => {
    if (visible || held.current === null) held.current = { value: registry.get(atom) };
    return held.current.value;
  });
}
