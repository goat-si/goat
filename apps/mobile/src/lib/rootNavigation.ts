import {
  createNavigationContainerRef,
  type NavigationContainerRef,
} from "@react-navigation/native";

export const rootNavigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

export function attachRootNavigation(
  navigation: NavigationContainerRef<ReactNavigation.RootParamList> | null,
): () => void {
  rootNavigationRef.current = navigation;
  return () => {
    // Android can attach the replacement root before detaching the previous root.
    if (rootNavigationRef.current === navigation) rootNavigationRef.current = null;
  };
}
