import { createContext, use, type ComponentProps } from "react";
import { Platform } from "react-native";
import { cn } from "../../lib/cn";
import { NativeScrollView as ScrollView } from "../../native/NativeScrollViewMarker";

export const ScreenScrollViewBottomInset = createContext(0);
/**
 * The screen's surface class. UIKit's scroll-edge material under the header takes the scroll
 * view's own color; a clear scroll view gets the system's near-white bar over the screen's surface.
 */
export const ScreenScrollViewSurface = createContext<string | undefined>(undefined);

export function ScreenScrollView({
  bottomPadding,
  ...props
}: ComponentProps<typeof ScrollView> & { readonly bottomPadding?: number }) {
  const bottomInset = Platform.OS === "ios" ? use(ScreenScrollViewBottomInset) : 0;
  const surface = use(ScreenScrollViewSurface);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      {...props}
      className={Platform.OS === "ios" && surface ? cn(surface, props.className) : props.className}
      contentInset={
        bottomPadding === undefined && bottomInset > 0
          ? { ...props.contentInset, bottom: (props.contentInset?.bottom ?? 0) + bottomInset }
          : props.contentInset
      }
      contentContainerStyle={[
        props.contentContainerStyle,
        bottomPadding !== undefined && { paddingBottom: bottomPadding + bottomInset },
        Platform.OS === "android" && {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        },
      ]}
    />
  );
}
