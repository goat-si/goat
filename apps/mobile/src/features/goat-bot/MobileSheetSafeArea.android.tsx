import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

/**
 * Android ignores a Modal's pageSheet and, edge to edge, draws it under the status and navigation
 * bars; a Modal is its own native hierarchy, so it measures its own safe area.
 */
export function MobileSheetSafeArea(props: { readonly children: ReactNode }) {
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <View className="flex-1 bg-screen">
        <SafeAreaView style={{ flex: 1 }}>{props.children}</SafeAreaView>
      </View>
    </SafeAreaProvider>
  );
}
