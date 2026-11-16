import type { ReactNode } from "react";

/** iOS presents a Modal's pageSheet below the status bar, so the sheet needs nothing more. */
export function MobileSheetSafeArea(props: { readonly children: ReactNode }) {
  return props.children;
}
