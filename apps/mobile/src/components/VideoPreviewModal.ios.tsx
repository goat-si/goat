import * as Dialog from "./ui/Dialog";
import { useIsFocused } from "@react-navigation/native";
import { requireNativeModule } from "expo";
import { settlePromise, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useId } from "react";
import { Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { fullscreenVideoClosed, fullscreenVideoOpened } from "../lib/videoAudioSession";
import {
  mediaVideoPreviewUri,
  videoPreviewKey,
  type VideoPreviewSource,
} from "../lib/videoPreviewSource";
import { useRefreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../lib/audioSession";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

const NativeControls = requireNativeModule<{
  presentVideo(
    uri: string,
    title: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
  addListener(
    event: "videoPlaybackChange",
    listener: (event: { identifier: string; isPlaying: boolean }) => void,
  ): { remove(): void };
}>("GoatNativeControls");

function NativeVideoPreview(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const environmentId =
    source.type === "media" && "environmentId" in source ? source.environmentId : null;
  const resource = source.type === "media" && "resource" in source ? source.resource : null;
  const preparedConnection = usePreparedConnection(environmentId);
  const refreshAssetUrl = useEffectEvent(useRefreshAssetUrl(environmentId, resource));
  const loadPresentation = useEffectEvent(async (signal: AbortSignal) => {
    const file =
      source.type === "local" ? await loadLocalAttachmentPreview(source.attachment, signal) : null;
    if (source.type === "local" && file === null) return null;
    const uri =
      file?.uri ??
      (source.type === "media"
        ? mediaVideoPreviewUri(source, "resource" in source ? await refreshAssetUrl() : null)
        : null);
    if (uri === null)
      throw new Error(
        preparedConnection._tag === "None"
          ? "Reconnect to this environment and open the video again."
          : "Could not load this video. Check the connection and try again.",
      );
    return {
      file,
      uri,
      name: source.type === "media" ? source.name : source.attachment.name,
      sourceIdentifier: source.sourceIdentifier ?? "",
    };
  });

  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    fullscreenVideoOpened();
    return () => fullscreenVideoClosed();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let token: ReturnType<typeof acquireAudioSession> | null = null;
    const release = () => {
      if (token) void releaseAudioSession(token).catch(() => {});
      token = null;
    };
    const acquire = () => {
      const next = acquireAudioSession("playback", () => {
        release();
        void NativeControls.dismissVideo(identifier).catch(() => {});
      });
      if (!isAudioSessionOwner(next)) {
        void NativeControls.dismissVideo(identifier).catch(() => {});
        return null;
      }
      token = next;
      return next;
    };
    const subscription = NativeControls.addListener("videoPlaybackChange", (event) => {
      if (event.identifier !== identifier || controller.signal.aborted) return;
      if (event.isPlaying) {
        if (!token) acquire();
      } else release();
    });
    let ready = false;
    void (async () => {
      // AVKit retains the URL without retry, so mint one for this presentation.
      const presentation = await loadPresentation(controller.signal);
      if (presentation === null) return;
      const { file, uri, name, sourceIdentifier } = presentation;
      try {
        if (controller.signal.aborted) return;
        const current = acquire();
        if (!current || !(await activateAudioSession(current, true)) || controller.signal.aborted) {
          release();
          if (!controller.signal.aborted) onRequestClose();
          return;
        }
        ready = true;
        const presented = await settlePromise(() =>
          NativeControls.presentVideo(uri, name, sourceIdentifier, identifier),
        );
        release();
        if (AsyncResult.isFailure(presented)) throw squashAtomCommandFailure(presented);
        if (!controller.signal.aborted) onRequestClose();
      } finally {
        // Native completion follows dismissal; keep the lease until playback closes.
        file?.dispose();
      }
    })().catch((error: unknown) => {
      release();
      if (controller.signal.aborted) return;
      // AVKit gives no retry, so re-mint now; the cached URL may simply have expired.
      if (ready) void refreshAssetUrl();
      Dialog.alert(
        "Could not open video",
        ready
          ? "This video couldn't be loaded or played. Check the connection, or touch and hold the video to save or share the original."
          : error instanceof Error
            ? error.message
            : "Could not load this video.",
      );
      onRequestClose();
    });
    return () => {
      controller.abort();
      subscription.remove();
      release();
      void NativeControls.dismissVideo(identifier).catch(() => undefined);
    };
  }, [identifier]);

  return null;
}

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!props.source || !isFocused) return null;
  return (
    <NativeVideoPreview
      key={videoPreviewKey(props.source)}
      source={props.source}
      onRequestClose={props.onRequestClose}
    />
  );
}
