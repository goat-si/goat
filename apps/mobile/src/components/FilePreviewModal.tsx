import { AssetWorkspaceAssetNotFoundError } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Dialog from "./ui/Dialog";
import { useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
  useMemo,
} from "react";
import { Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import {
  downloadAndShareAttachment,
  nativeViewerErrorMessage,
  shareLocalAttachment,
} from "../lib/attachmentDownload";
import { useRefreshAssetUrl } from "../state/assets";
import {
  filePreviewGallery,
  filePreviewKey,
  filePreviewName,
  filePreviewSourceIdentifier,
  pdfActionsSource,
} from "../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import { FilePreview, supportsProgressiveFilePreview } from "./FilePreview";
import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

function remotePreviewFailureMessage(error: unknown): string {
  if (!isAssetNotFoundError(error)) {
    return "Reconnect to this environment and try again. The file may have been moved or deleted.";
  }
  const path = error.checkedPath ?? ("path" in error.resource ? error.resource.path : undefined);
  return path ? `The file was not found at ${path}.` : error.message;
}

function PreviewItemResolver(props: {
  readonly source: FilePreviewItem;
  readonly onResolved: (source: ResolvedFilePreviewSource | null) => void;
  readonly progressive: boolean;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { source } = props;
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const refreshAssetUrl = useRefreshAssetUrl(
    environmentId,
    "resource" in source ? source.resource : null,
    { reportError: true },
  );
  // Resolve once per presentation; background URL refreshes must not reopen the native viewer.
  const [uri, setUri] = useState<string | null>("uri" in source ? source.uri : null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onResolutionError = useEffectEvent((error: unknown, fallbackMessage: string) => {
    if (props.progressive) {
      props.onResolved(null);
      return;
    }
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", fallbackMessage);
    onRequestClose();
  });
  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (environmentId === null || uri !== null) return;
    let cancelled = false;
    // Refresh expired URLs before handing them to Quick Look or ACTION_VIEW, which retain them.
    void refreshAssetUrl()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to this environment and try again.");
        setUri(url + (source.srcFragment ?? ""));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onResolutionError(error, remotePreviewFailureMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, uri, refreshAssetUrl, source.srcFragment]);
  useEffect(() => {
    if (!("attachment" in source)) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadLocalAttachmentPreview(source.attachment, controller.signal)
      .then((file) => {
        if (!file) return;
        if (controller.signal.aborted) {
          file.dispose();
          return;
        }
        release = file.dispose;
        setUri(file.uri);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        onResolutionError(error, "Attach the file again and retry.");
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [source]);

  const onResolved = useEffectEvent(props.onResolved);
  useEffect(() => {
    if (uri !== null)
      onResolved({
        ...source,
        name: filePreviewName(source),
        uri,
        ...(source.kind === "pdf" ? { actionsSource: pdfActionsSource(source) } : {}),
      });
  }, [uri, source]);
  return null;
}

function ResolvedFilePreview(props: {
  readonly onPresent: (isFinished: () => boolean) => void;
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  // Freeze the group at opening; streaming messages and URL refreshes must not reopen the viewer.
  const [items] = useState(() => filePreviewGallery(props.source, []));
  const progressive = props.source.kind === "image" && supportsProgressiveFilePreview();
  const [resolved, setResolved] = useState<Record<string, ResolvedFilePreviewSource | null>>({});
  const onResolved = useCallback((item: ResolvedFilePreviewSource | null, key: string) => {
    setResolved((current) => ({ ...current, [key]: item }));
  }, []);
  const selectedKey = filePreviewKey(props.source);
  const selected = resolved[selectedKey];
  const gallery = useMemo(
    () =>
      items.flatMap((item) => {
        const value = resolved[filePreviewKey(item)];
        return value ? [value] : [];
      }),
    [items, resolved],
  );
  const viewerSource = progressive
    ? {
        kind: "image" as const,
        selectedIndex: items.findIndex((item) => filePreviewKey(item) === selectedKey),
        images: items.map((item) => {
          const value = resolved[filePreviewKey(item)];
          return {
            name: filePreviewName(item),
            sourceIdentifier: filePreviewSourceIdentifier(item),
            uri: value === null ? null : (value?.uri ?? ("uri" in item ? item.uri : undefined)),
          };
        }),
      }
    : selected && gallery.length === items.length
      ? { ...selected, gallery }
      : null;
  const onOpenError = (error: unknown) => {
    if (props.onOpenError) return props.onOpenError(error);
    Dialog.alert("Could not open preview", nativeViewerErrorMessage(error), [
      { text: "Cancel", style: "cancel" },
      ...(selected?.kind === "document"
        ? [
            {
              text: "Save or share",
              onPress: () => {
                const input = {
                  attachment: {
                    name: filePreviewName(selected),
                    mimeType: selected.mimeType ?? "application/octet-stream",
                  },
                  signal: new AbortController().signal,
                };
                const sharing = /^(file|content):/.test(selected.uri)
                  ? shareLocalAttachment({ ...input, uri: selected.uri })
                  : downloadAndShareAttachment({ ...input, url: selected.uri });
                void sharing.catch(() => Dialog.alert("Could not share file", "Please try again."));
              },
            },
          ]
        : []),
    ]);
  };
  return (
    <>
      {items.map((item) => (
        <PreviewItemResolver
          key={filePreviewKey(item)}
          source={item}
          progressive={progressive}
          onResolved={(value) => onResolved(value, filePreviewKey(item))}
          onRequestClose={props.onRequestClose}
          onOpenError={props.onOpenError}
        />
      ))}
      {viewerSource ? (
        <FilePreview
          source={viewerSource}
          onRequestClose={props.onRequestClose}
          onOpenError={onOpenError}
          onPresent={props.onPresent}
        />
      ) : null}
    </>
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly attemptId?: number;
  readonly onRequestClose: () => void;

  readonly onOpenError?: (error: unknown) => void;
}) {
  const group = useContext(FilePreviewGallery);
  const source = useMemo(
    () =>
      props.source === null
        ? null
        : {
            ...props.source,
            gallery: filePreviewGallery(props.source, group),
          },
    [props.source, group],
  );
  const navigation = useNavigation();
  const subscribeToFocus = useCallback(
    (listener: () => void) => {
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation],
  );
  // The legacy envelope's focus context may describe a different route than this v5 card.
  const isFocused = useSyncExternalStore(
    subscribeToFocus,
    navigation.isFocused,
    navigation.isFocused,
  );
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  const activeSource = isFocused ? props.source : null;
  const [opening, setOpening] = useState<{
    readonly source: FilePreviewSource | null;
    readonly attemptId: number | undefined;
    readonly generation: number;
    readonly isFinished: (() => boolean) | null;
  }>({ source: activeSource, attemptId: props.attemptId, generation: 0, isFinished: null });
  const newAttempt = opening.attemptId !== props.attemptId;
  if (opening.source !== activeSource || newAttempt) {
    const sameItem =
      opening.source !== null &&
      activeSource !== null &&
      filePreviewKey(opening.source) === filePreviewKey(activeSource);
    // UIKit can expose the thumbnail before its close callback reaches JS.
    const requestedAgain = props.attemptId === undefined || newAttempt;
    const keepOpening = sameItem && (!requestedAgain || !opening.isFinished?.());
    setOpening({
      source: activeSource,
      attemptId: props.attemptId,
      generation: opening.generation + (keepOpening ? 0 : 1),
      isFinished: keepOpening ? opening.isFinished : null,
    });
  }
  const { generation } = opening;
  const onPresent = useCallback(
    (isFinished: () => boolean) =>
      setOpening((current) =>
        current.generation === generation ? { ...current, isFinished } : current,
      ),
    [generation],
  );

  if (!source || !isFocused) return null;
  return (
    <ResolvedFilePreview
      key={generation}
      onPresent={onPresent}
      source={source}
      onRequestClose={props.onRequestClose}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
