import type { EnvironmentId, ThreadId } from "@goat/contracts";
import type { DraftId } from "../composerDraftStore";

export type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      /** Rendered inside another thread's right panel, as that thread's side chat. */
      embedded?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      embedded?: never;
      routeKind: "draft";
      draftId: DraftId;
    };
