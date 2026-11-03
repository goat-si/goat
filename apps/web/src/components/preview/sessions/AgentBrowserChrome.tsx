import type { PreviewSession } from "@goat/contracts";
import { ThreadId } from "@goat/contracts";
import { resolveAddressBarInput, resolveSearchUrlTemplate } from "@goat/shared/preview";

import { getClientSettings } from "~/hooks/useSettings";
import { useThreadPreviewState, type DesktopPreviewOverlay } from "~/previewStateStore";
import { toastManager } from "~/components/ui/toast";
import { PreviewChromeRow } from "../PreviewChromeRow";
import { previewBridge } from "../previewBridge";
import { reportPreviewAddressError } from "../previewAddressError";

export type BrowserIntent =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload" };

export function AgentBrowserChrome(props: {
  readonly session: PreviewSession;
  readonly nativePicture: boolean;
  readonly hosted: {
    readonly runtimeTabId: string;
    readonly overlay: DesktopPreviewOverlay | null;
  } | null;
  readonly streamEnabled: boolean;
  readonly onIntent: (intent: BrowserIntent) => void;
}) {
  const { session } = props;
  const threadRef =
    session.threadId === undefined
      ? null
      : {
          environmentId: session.environmentId,
          threadId: ThreadId.make(session.threadId),
        };
  const state = useThreadPreviewState(threadRef);
  if (threadRef === null || session.target.kind !== "browser") return null;
  const tabId = session.target.tabId;
  const snapshot = state.sessions[tabId];
  const navStatus = snapshot?.navStatus;
  const overlay = props.nativePicture ? props.hosted?.overlay : null;
  const loading = overlay?.loading ?? navStatus?._tag === "Loading";
  const enabled = props.nativePicture
    ? props.hosted !== null && previewBridge !== null
    : props.streamEnabled;
  const invoke = (intent: BrowserIntent) => {
    if (!enabled) return;
    if (!props.nativePicture) {
      props.onIntent(intent);
      return;
    }
    if (!props.hosted || !previewBridge) return;
    const id = props.hosted.runtimeTabId;
    const result =
      intent.type === "navigate"
        ? previewBridge.navigate(id, intent.url)
        : intent.type === "reload"
          ? previewBridge.refresh(id)
          : intent.delta === -1
            ? previewBridge.goBack(id)
            : previewBridge.goForward(id);
    void result.catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Unable to navigate browser",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  return (
    <PreviewChromeRow
      density="compact"
      addressKey={JSON.stringify([threadRef.environmentId, threadRef.threadId, tabId])}
      threadRef={threadRef}
      tabId={tabId}
      tabs={[]}
      history={[]}
      onActivateTab={() => false}
      url={navStatus && navStatus._tag !== "Idle" ? navStatus.url : session.target.url}
      loading={loading}
      canGoBack={enabled && (overlay?.canGoBack ?? snapshot?.canGoBack ?? false)}
      canGoForward={enabled && (overlay?.canGoForward ?? snapshot?.canGoForward ?? false)}
      refreshDisabled={!enabled}
      inputDisabled={!enabled}
      onBack={() => invoke({ type: "history", delta: -1 })}
      onForward={() => invoke({ type: "history", delta: 1 })}
      onRefresh={() => invoke({ type: "reload" })}
      onSubmit={(input) => {
        try {
          invoke({
            type: "navigate",
            url: resolveAddressBarInput(input, resolveSearchUrlTemplate(getClientSettings())),
          });
        } catch (error) {
          reportPreviewAddressError(error);
        }
      }}
      onInvalidInput={reportPreviewAddressError}
    />
  );
}
