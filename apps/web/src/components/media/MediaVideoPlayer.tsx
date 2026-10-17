import { PlayIcon, RotateCwIcon, TriangleAlertIcon } from "~/components/solar";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { Button } from "../ui/button";
import { OpenMediaLink } from "./OpenMediaLink";
import { MediaActions, type MediaActionSource } from "./MediaActions";
import { isMediaSourceAvailable } from "./mediaContent";

interface MediaVideoPlayerProps {
  readonly src: string | null;
  readonly label: string;
  readonly sourceFailed?: boolean | undefined;
  readonly originalUrl?: string | undefined;
  readonly revision?: string | null | undefined;
  readonly preload?: "visible" | "metadata" | undefined;
  readonly autoPlay?: boolean | undefined;
  /** Presents a still thumbnail whose full surface opens the video in a viewer. */
  readonly onOpen?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly videoClassName?: string | undefined;
  /** Styles the loading and failure panels, which otherwise assume an inline light surface. */
  readonly stateClassName?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly copyMarkdown?: string | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
}

interface PlaybackState {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly playbackRate: number;
}

/** Keeps native range streaming and playback state consistent across inline and file previews. */
export function MediaVideoPlayer({
  src: latestSrc,
  label,
  sourceFailed = false,
  originalUrl,
  revision = null,
  preload = "visible",
  autoPlay = false,
  onOpen,
  className,
  videoClassName,
  stateClassName,
  style,
  copyMarkdown,
  onRetry,
  actionsSource,
}: MediaVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackSource, setPlaybackSource] = useState<{
    src: string;
    revision: string | null;
    latestAtPin: string | null;
  } | null>(null);
  const [failure, setFailure] = useState<{ src: string; format: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [availableFormatFailure, setAvailableFormatFailure] = useState(failure);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const pendingRestore = useRef<PlaybackState | null>(null);
  const autoRefreshUsed = useRef(false);
  const recoveryFrom = useRef<string | null>(null);
  const recoveryTime = useRef<number | null>(null);
  const latestSrcRef = useRef(latestSrc);
  const src = playbackSource?.src ?? latestSrc;
  const failed = src !== null ? failure?.src === src : sourceFailed;
  const videoVisible = src !== null && !failed;

  useEffect(() => {
    latestSrcRef.current = latestSrc;
  }, [latestSrc]);

  useEffect(() => {
    if (!failure?.format) return;
    const controller = new AbortController();
    const failedSrc = failure.src;
    void isMediaSourceAvailable(failedSrc, controller.signal).then((available) => {
      if (!controller.signal.aborted && available) setAvailableFormatFailure(failure);
    });
    return () => controller.abort();
  }, [failure]);

  const rememberPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    pendingRestore.current = {
      currentTime: video.currentTime,
      paused: video.paused,
      volume: video.volume,
      muted: video.muted,
      playbackRate: video.playbackRate,
    };
  }, []);

  // Keep a playing range request on its original URL, then adopt the latest signed URL on pause.
  const refreshPausedRevision = useCallback(() => {
    const video = videoRef.current;
    if (
      playbackSource !== null &&
      latestSrc !== null &&
      pendingRestore.current === null &&
      (video === null || video.paused || video.ended) &&
      (playbackSource.latestAtPin !== latestSrc || playbackSource.revision !== revision)
    ) {
      rememberPlayback();
      setPlaybackSource({ src: latestSrc, revision, latestAtPin: latestSrc });
    }
  }, [latestSrc, playbackSource, rememberPlayback, revision]);
  useEffect(refreshPausedRevision, [refreshPausedRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (!videoVisible || !video || preload === "metadata" || preloadedSrc === src) return;
    if (typeof IntersectionObserver === "undefined") {
      setPreloadedSrc(src);
      return;
    }
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        setPreloadedSrc(src);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(video);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [src, preload, preloadedSrc, videoVisible]);

  useEffect(() => {
    if (!videoVisible) return;
    const video = videoRef.current;
    if (!video) return;
    const pauseWhenHidden = () => {
      // Native fullscreen can hide the inline page while this video is still visible.
      const fullscreen =
        document.fullscreenElement?.contains(video) ||
        ("webkitDisplayingFullscreen" in video && video.webkitDisplayingFullscreen === true);
      if (document.hidden && !fullscreen) video.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    document.addEventListener("fullscreenchange", pauseWhenHidden);
    video.addEventListener("webkitendfullscreen", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      document.removeEventListener("fullscreenchange", pauseWhenHidden);
      video.removeEventListener("webkitendfullscreen", pauseWhenHidden);
      video.pause();
    };
  }, [videoVisible]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const renewed = await onRetry?.();
      setPlaybackSource(
        typeof renewed === "string"
          ? { src: renewed, revision, latestAtPin: latestSrcRef.current }
          : null,
      );
      setFailure(null);
      setAvailableFormatFailure(null);
      autoRefreshUsed.current = false;
      recoveryFrom.current = null;
      recoveryTime.current = null;
    } catch {
      if (src !== null) setFailure({ src, format: false });
    } finally {
      setRetrying(false);
    }
  };

  const player = (
    <span
      className={cn("relative inline-block align-middle", className)}
      style={style}
      data-markdown-copy={copyMarkdown}
    >
      {failed && !onOpen ? (
        <span
          role="alert"
          className={cn(
            // Same 16:9 slot as the loading and playing states, so a failed or
            // retried video does not move the rows below it.
            "flex aspect-video max-h-full min-h-28 w-full flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-muted/40 p-4 text-center text-sm text-muted-foreground",
            stateClassName,
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            {failure?.src === src && failure.format && availableFormatFailure === failure
              ? "This video format can't be played here"
              : "Video unavailable"}
            {label ? ` · ${label}` : ""}
          </span>
          <span className="flex flex-wrap items-center justify-center gap-2">
            {latestSrc !== null || onRetry ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={retrying}
                onClick={() => void retry()}
              >
                <RotateCwIcon />
                {retrying ? "Retrying…" : "Retry video"}
              </Button>
            ) : null}
            <OpenMediaLink originalUrl={originalUrl} src={latestSrc ?? src} fileName={label} />
          </span>
        </span>
      ) : src !== null && !failed ? (
        <video
          ref={videoRef}
          src={src}
          aria-label={label || "Video preview"}
          aria-hidden={onOpen ? true : undefined}
          autoPlay={onOpen ? false : autoPlay}
          controls={!onOpen}
          muted={onOpen ? true : undefined}
          playsInline
          preload={preload === "metadata" || preloadedSrc === src ? "metadata" : "none"}
          className={cn(
            "aspect-video max-h-full w-full bg-black object-contain",
            onOpen && "pointer-events-none",
            videoClassName,
          )}
          style={style}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const restore = pendingRestore.current;
            pendingRestore.current = null;
            if (!restore) {
              prepareVideoFirstFrame(video);
              return;
            }
            video.volume = restore.volume;
            video.muted = restore.muted;
            video.playbackRate = restore.playbackRate;
            try {
              video.currentTime = restore.currentTime;
            } catch {
              // A rejected seek still leaves the refreshed video playable.
            }
            if (!restore.paused) void video.play().catch(() => undefined);
          }}
          onPlay={() =>
            setPlaybackSource((current) =>
              current?.src === src ? current : { src, revision, latestAtPin: latestSrc },
            )
          }
          onTimeUpdate={(event) => {
            const video = event.currentTarget;
            if (
              recoveryTime.current !== null &&
              video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.currentTime > recoveryTime.current + 0.5
            ) {
              autoRefreshUsed.current = false;
              recoveryFrom.current = null;
              recoveryTime.current = null;
            }
          }}
          onPause={refreshPausedRevision}
          onEnded={refreshPausedRevision}
          onError={(event) => {
            if (recoveryFrom.current === src) return;
            const code = event.currentTarget.error?.code;
            const format = code === 3 || code === 4;
            const newerSrc =
              latestSrc !== null && latestSrc !== src && latestSrc !== playbackSource?.latestAtPin
                ? latestSrc
                : null;
            if (autoRefreshUsed.current || (!newerSrc && !onRetry)) {
              // Keep the position for a manual retry, which mounts a fresh video element.
              if (pendingRestore.current === null) rememberPlayback();
              setFailure({ src, format: format && (autoRefreshUsed.current || src === latestSrc) });
              return;
            }
            autoRefreshUsed.current = true;
            recoveryFrom.current = src;
            rememberPlayback();
            recoveryTime.current = event.currentTarget.currentTime;
            if (newerSrc) {
              setPlaybackSource({ src: newerSrc, revision, latestAtPin: newerSrc });
              return;
            }
            const refresh = onRetry;
            if (!refresh) return;
            setRetrying(true);
            void refresh()
              .then((renewed) => {
                const nextSrc =
                  latestSrcRef.current !== null && latestSrcRef.current !== src
                    ? latestSrcRef.current
                    : typeof renewed === "string" && renewed !== src
                      ? renewed
                      : null;
                if (nextSrc === null) {
                  setFailure({ src, format });
                  return;
                }
                setPlaybackSource({ src: nextSrc, revision, latestAtPin: latestSrcRef.current });
              })
              .catch(() => setFailure({ src, format: false }))
              .finally(() => setRetrying(false));
          }}
        />
      ) : (
        <span
          role="status"
          aria-label={failed ? "Video preview unavailable" : "Loading video"}
          className={cn("block aspect-video w-full rounded-lg bg-muted/60", stateClassName)}
          style={style}
        />
      )}
      {onOpen ? (
        <button
          type="button"
          aria-label={label ? `Play ${label}` : "Play video"}
          onClick={onOpen}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon aria-hidden className="size-4 fill-current" />
          </span>
        </button>
      ) : null}
    </span>
  );
  return actionsSource ? <MediaActions source={actionsSource}>{player}</MediaActions> : player;
}
