import type { PreviewAnnotationPayload, ScopedThreadRef } from "@goat/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";

export interface PreviewViewProps {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}
