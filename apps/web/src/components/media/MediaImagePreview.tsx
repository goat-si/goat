import { useEffect, useState } from "react";

import { mediaMimeTypeFromExtension } from "@goat/shared/filePreview";
import { RotateCwIcon, TriangleAlertIcon } from "~/components/solar";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { isMediaSourceAvailable } from "./mediaContent";
import { OpenMediaLink } from "./OpenMediaLink";

/** Tries the platform's image decoder first; HEIC/HEIF support varies across clients. */
export function MediaImagePreview(props: {
  readonly src: string | null;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly originalUrl?: string | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [unsupportedSrc, setUnsupportedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const src = props.src;
  const suppliedMimeType = props.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const mimeType =
    !suppliedMimeType ||
    suppliedMimeType === "application/octet-stream" ||
    suppliedMimeType === "text/plain"
      ? mediaMimeTypeFromExtension(props.name.slice(props.name.lastIndexOf(".")))
      : suppliedMimeType;
  const isHeif = mimeType === "image/heic" || mimeType === "image/heif";
  const failed = props.sourceFailed || (src !== null && failedSrc === src);
  const unsupported = !props.sourceFailed && src !== null && unsupportedSrc === src;

  useEffect(() => {
    if (!isHeif || src === null || failedSrc !== src || props.sourceFailed) return;
    const controller = new AbortController();
    void isMediaSourceAvailable(src, controller.signal).then((available) => {
      if (!controller.signal.aborted && available) setUnsupportedSrc(src);
    });
    return () => controller.abort();
  }, [failedSrc, isHeif, src, props.sourceFailed]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const retryLoad = async () => {
      await props.onRetry?.();
      setFailedSrc(null);
      setUnsupportedSrc(null);
      setAttempt((current) => current + 1);
    };
    await retryLoad()
      .catch(() => {
        // Keep the failed preview and its actions available while disconnected.
      })
      .finally(() => {
        setRetrying(false);
      });
  };

  if (failed) {
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
      >
        <p className="inline-flex items-center gap-1.5 text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          {unsupported
            ? "This image format can't be displayed here. Download it to open in another app."
            : "Unable to load workspace image."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void retry()}>
            <RotateCwIcon />
            {retrying ? "Retrying…" : "Retry image"}
          </Button>
          <OpenMediaLink
            originalUrl={props.originalUrl}
            src={src}
            fileName={props.name}
            kind="image"
          />
        </div>
      </div>
    );
  }

  return src !== null ? (
    // oxlint-disable-next-line goat/require-centered-scroll-gutter -- The image is capped at max-h-full max-w-full, so this never scrolls.
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        key={`${src}:${attempt}`}
        className="max-h-full max-w-full object-contain"
        src={src}
        alt={props.name}
        onError={() => setFailedSrc(src)}
      />
    </div>
  ) : (
    <div
      role="status"
      aria-label="Loading image"
      className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
    >
      <Spinner size="lg" />
    </div>
  );
}
