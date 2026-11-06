import type { ScopedThreadRef } from "@goat/contracts";
import { usePreviewSession } from "./usePreviewSession";

export function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}
