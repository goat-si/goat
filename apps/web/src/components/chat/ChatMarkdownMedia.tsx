import { MISSING_FILE_ACCESS_MESSAGE } from "@goat/client-runtime/state/assets";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import { mediaFileReference, mediaUrlReference } from "@goat/client-runtime/media-reference";
import { ExternalLinkIcon, TriangleAlertIcon } from "~/components/solar";
import type { AssetResource, EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@goat/contracts";
import type { Element as HastElement } from "hast";
import {
  createContext,
  memo,
  type ReactNode,
  use,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import {
  readEnvironmentMediaRoute,
  useEnvironmentMediaRoute,
} from "../../browser/openEnvironmentUrl";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";
import { Button } from "../ui/button";
import { RotateCwIcon } from "~/components/solar";

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
export const MarkdownLinkContext = createContext(false);
/** The thread's workspace mutation id, so a host image the agent rewrites gets a fresh URL. */
export const WorkspaceMutationIdContext = createContext<string | null | undefined>(undefined);
/** The environment Markdown media came from; the gallery routes its links there when it opens. */
export const MarkdownEnvironmentContext = createContext<EnvironmentId | null>(null);
/** Lets an image inside a link report a failed load to the link, which offers the page beside it. */
const LinkedImageFailureContext = createContext<((url: string) => void) | null>(null);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
  routeUrl: ((url: string) => EnvironmentLoopbackUrl) | null,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item, routeUrl));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | "audio" | undefined;
  readonly detail?: string | undefined;
}) {
  const label =
    props.kind === "audio"
      ? "Audio unavailable"
      : props.kind === "video"
        ? "Video unavailable"
        : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {[label, props.alt, props.detail].filter(Boolean).join(" · ")}
    </span>
  );
}

/** Opens a page in the preview sidebar; it never falls back to the system browser. */
type OpenPage = () => Promise<AtomCommandResult<unknown, unknown>>;
export type OpenUrlInPreview = (url: string) => Promise<AtomCommandResult<unknown, unknown>>;

/** An image URL the preview sidebar can open as a page when no image comes back. */
function isWebPageUrl(uri: string): boolean {
  return /^(?:https?:)?\/\//i.test(uri);
}

/** The web URL of the image a Markdown link wraps. */
/** The web URLs of the images inside a Markdown link, at any depth. */
function linkedWebImageUrls(node: HastElement | undefined): string[] {
  return (node?.children ?? []).flatMap((child) => {
    if (child.type !== "element") return [];
    const src = child.tagName === "img" ? child.properties.src : undefined;
    return typeof src === "string" && isWebPageUrl(src) ? [src] : linkedWebImageUrls(child);
  });
}

function OpenPageButton(props: { readonly onOpenPage: OpenPage }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void props.onOpenPage().then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            reportMarkdownActionFailure({ operation: "open-link-in-preview" }, result.cause);
          }
        });
      }}
    >
      <ExternalLinkIcon />
      Open page
    </Button>
  );
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video" | "audio";
  readonly actionsSource?: MediaActionSource | undefined;
  readonly detail?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  readonly onOpenPage?: OpenPage | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "inline-flex items-center gap-2 rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} detail={props.detail} />
      {props.onRetry && (
        <Button size="sm" variant="secondary" disabled={props.retrying} onClick={props.onRetry}>
          <RotateCwIcon />
          {props.retrying ? "Retrying…" : "Retry image"}
        </Button>
      )}
      {props.onOpenPage && <OpenPageButton onOpenPage={props.onOpenPage} />}
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
function ChatMarkdownImage(props: {
  readonly src: string | null;
  readonly srcFragment?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  /** Offered once the image fails, for a URL that is a web page rather than an image. */
  readonly onOpenPage?: OpenPage | undefined;
  readonly onLoadError?: (() => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const environmentId = use(MarkdownEnvironmentContext);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
      ...(props.srcFragment ? { srcFragment: props.srcFragment } : {}),
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
      props.onLoadError?.();
    },
  });
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const retryLoad = async () => {
      await props.onRetry?.();
      setFailedSrc(null);
      setLoadedSrc(null);
      setLoadAttempt((attempt) => attempt + 1);
    };
    await retryLoad()
      .catch(() => {
        // Keep the failure visible until a later signed URL or retry succeeds.
      })
      .finally(() => {
        setRetrying(false);
      });
  };

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          key={loadAttempt}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          loading="lazy"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt, (url) =>
            readEnvironmentMediaRoute(environmentId, url),
          )}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        detail={props.unavailableDetail}
        onRetry={props.onRetry ? () => void retry() : undefined}
        retrying={retrying}
        onOpenPage={props.onOpenPage}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full flex-wrap items-center justify-center gap-2 p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} detail={props.unavailableDetail} />
            {props.onRetry && (
              <Button
                size="sm"
                variant="secondary"
                disabled={retrying}
                onClick={() => void retry()}
              >
                <RotateCwIcon />
                {retrying ? "Retrying…" : "Retry image"}
              </Button>
            )}
            {props.onOpenPage && <OpenPageButton onOpenPage={props.onOpenPage} />}
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            key={loadAttempt}
            src={src}
            alt={props.alt}
            decoding="async"
            loading="lazy"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | typeof SOURCE_CONTROL_MEDIA_ASSET
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const resource = props.resource;
  const threadWorkspaceMutationId = use(WorkspaceMutationIdContext);
  const workspaceMutationId = props.workspaceMutationId ?? threadWorkspaceMutationId;
  const assetUrl = useAssetUrlState(
    props.environmentId,
    resource,
    workspaceMutationId !== undefined &&
      props.kind !== "video" &&
      (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? workspaceMutationId
      : undefined,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && props.workspaceRoot
        ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const panelPath =
    reference?.kind === "file" ? (reference.relativePath ?? reference.path) : undefined;
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    ...(panelPath && (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                panelPath,
              ),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      srcFragment={props.srcFragment}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      unavailableDetail={
        assetUrl._tag === "Failure" &&
        assetUrl.reason === "missing-file-access" &&
        fallbackSrc === undefined
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
      onRetry={fallbackSrc === undefined ? refreshAssetUrl : undefined}
    />
  );
});
/**
 * A Markdown image or video with a URL source. A loopback URL means the thread's environment, so it
 * loads from that machine's address, or explains why this device cannot reach it.
 */
export function ChatMarkdownDirectMedia(props: {
  readonly environmentId: EnvironmentId | null;
  readonly uri: string;
  readonly kind: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /** Set when this client may open pages in the preview sidebar. */
  readonly openInPreview?: OpenUrlInPreview | undefined;
}) {
  const routed = useEnvironmentMediaRoute(props.environmentId)(props.uri);
  const inLink = use(MarkdownLinkContext);
  const reportLinkedFailure = use(LinkedImageFailureContext);
  const openInPreview = props.openInPreview;
  const onOpenPage =
    openInPreview && props.kind === "image" && !inLink && isWebPageUrl(props.uri)
      ? () => openInPreview(props.uri)
      : undefined;
  const src = routed._tag === "Open" ? routed.url : null;
  const originalUrl = resolveExternalWebLinkHost(props.uri) !== null ? props.uri : undefined;
  const reference = mediaUrlReference(props.uri);
  const actionsSource: MediaActionSource = {
    kind: props.kind,
    name: props.alt || props.kind,
    src,
    ...(reference ? { reference } : {}),
  };
  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={src === null}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={originalUrl}
        style={props.style}
        mediaIdentity={src ?? `unavailable:${props.uri}`}
        actionsSource={actionsSource}
      />
    );
  }
  return (
    <ChatMarkdownImage
      key={src ?? props.uri}
      src={src}
      sourceFailed={src === null}
      unavailableDetail={routed._tag === "Unreachable" ? routed.reason : undefined}
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone}
      className={props.className}
      style={props.style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={originalUrl}
      onImageExpand={props.onImageExpand}
      onOpenPage={onOpenPage}
      onLoadError={reportLinkedFailure ? () => reportLinkedFailure(props.uri) : undefined}
    />
  );
}

/**
 * Wraps a link around URL images. A button cannot sit inside the link, so the page of an image that
 * fails, or that this device cannot reach, is offered beside the link instead.
 */
function LinkedImageOpenPage(props: {
  readonly environmentId: EnvironmentId | null;
  readonly imageUrls: ReadonlyArray<string>;
  readonly openInPreview: OpenUrlInPreview;
  readonly children: ReactNode;
}) {
  const route = useEnvironmentMediaRoute(props.environmentId);
  const routeOf = (url: string) => {
    const routed = route(url);
    return routed._tag === "Open" ? routed.url : null;
  };
  // Remembers the route it failed on, so a reconnect that moves the address tries the image again.
  const [failure, setFailure] = useState<{ url: string; route: string } | null>(null);
  const failedUrl =
    props.imageUrls.find((url) => routeOf(url) === null) ??
    (failure !== null && routeOf(failure.url) === failure.route ? failure.url : undefined);
  const reportFailure = (url: string) => {
    const failedRoute = routeOf(url);
    if (failedRoute !== null) setFailure({ url, route: failedRoute });
  };
  return (
    <>
      <LinkedImageFailureContext value={reportFailure}>{props.children}</LinkedImageFailureContext>
      {failedUrl !== undefined && (
        <span data-thread-find-ignore className="ms-2 inline-flex align-middle">
          <OpenPageButton onOpenPage={() => props.openInPreview(failedUrl)} />
        </span>
      )}
    </>
  );
}

/** Wraps a link holding URL images, so a failed image offers its page beside the link. */
export function withLinkedImagePage(
  link: ReactNode,
  input: {
    readonly node: HastElement | undefined;
    readonly environmentId: EnvironmentId | null;
    readonly openInPreview: OpenUrlInPreview | undefined;
  },
): ReactNode {
  const imageUrls = input.openInPreview ? linkedWebImageUrls(input.node) : [];
  if (!input.openInPreview || imageUrls.length === 0) return link;
  return (
    <LinkedImageOpenPage
      environmentId={input.environmentId}
      imageUrls={imageUrls}
      openInPreview={input.openInPreview}
    >
      {link}
    </LinkedImageOpenPage>
  );
}
