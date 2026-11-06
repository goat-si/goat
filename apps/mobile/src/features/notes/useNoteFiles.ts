import { resolveNoteFilePath } from "@goat/client-runtime/notes";
import { resolveAssetUrl } from "@goat/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { hostPreviewMimeTypeFromExtension } from "@goat/shared/filePreview";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { openAttachmentInViewer } from "../../lib/attachmentDownload";
import { DOCUMENT_MIME_TYPES } from "../../lib/markdownMedia";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { MarkdownImageSourceResolver } from "../../native/SelectableMarkdownText.types";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentPresentation } from "../../state/presentation";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

export type NoteFileMint =
  | { readonly ok: true; readonly url: string; readonly expiresAt: number }
  /** `permanent` failures will not change by retrying; the rest wait for the connection. */
  | { readonly ok: false; readonly permanent: boolean };

const PERMANENT_FAILURES = new Set([
  "AssetWorkspaceAssetNotFoundError",
  "AssetPreviewTypeValidationError",
  "EnvironmentAuthorizationError",
]);
const DIRECT_IMAGE = /^(?:https?:|data:image\/)/i;
// Android hands this type to the viewer chooser, so plain files need a real one too.
const FILE_MIME_TYPES: Readonly<Record<string, string>> = {
  ...DOCUMENT_MIME_TYPES,
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
};

export function noteFileMimeType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return (
    FILE_MIME_TYPES[extension] ??
    hostPreviewMimeTypeFromExtension(extension) ??
    "application/octet-stream"
  );
}

/** Signs URLs for files embedded in notes. Its identity changes when the connection does. */
export function useNoteFileMint(environmentId: EnvironmentId) {
  const connection = usePreparedConnection(environmentId);
  const phase = useEnvironmentPresentation(environmentId).presentation?.connection.phase;
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const online =
    httpBaseUrl !== null &&
    phase !== "offline" &&
    phase !== "error" &&
    phase !== "unsupported" &&
    phase !== "reconnecting";
  const mint = async (path: string, disposition?: "attachment"): Promise<NoteFileMint> => {
    if (!online || httpBaseUrl === null) return { ok: false, permanent: false };
    const result = await createUrl({
      environmentId,
      input: { resource: { _tag: "note-file", path, ...(disposition ? { disposition } : {}) } },
    });
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : "";
      return { ok: false, permanent: PERMANENT_FAILURES.has(String(tag)) };
    }
    const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
    return url === null
      ? { ok: false, permanent: false }
      : { ok: true, url, expiresAt: result.value.expiresAt };
  };
  return { mint, online };
}

/**
 * Images in the read view. Anything that will never load settles as unavailable so the text
 * shows its fallback; a connection problem throws, and the image asks again once it reconnects.
 */
export function useNoteImageSource(
  environmentId: EnvironmentId,
  notePath: string,
): MarkdownImageSourceResolver {
  const { mint } = useNoteFileMint(environmentId);
  return async (image) => {
    if (DIRECT_IMAGE.test(image.href)) return { uri: image.href };
    const path = resolveNoteFilePath(notePath, image.href);
    if (path === null) return null;
    const minted = await mint(path);
    if (minted.ok) return { uri: minted.url };
    if (minted.permanent) return null;
    throw new Error("Note images load once the environment reconnects.");
  };
}

/**
 * Links in a note. An attachment downloads inside the app, over the connection images already use,
 * and opens in the system viewer; anything else opens as before.
 */
export function useOpenNoteLink(environmentId: EnvironmentId, notePath: string) {
  const { mint } = useNoteFileMint(environmentId);
  return (href: string) => {
    const path = resolveNoteFilePath(notePath, href);
    if (path === null) {
      void tryOpenExternalUrl(href, "markdown-link");
      return;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const mimeType = noteFileMimeType(name);
    void (async () => {
      const minted = await mint(path, "attachment");
      if (!minted.ok)
        throw new Error(
          minted.permanent
            ? "This file is no longer in your notes."
            : "Reconnect to the environment and try again.",
        );
      await openAttachmentInViewer({
        uri: minted.url,
        attachment: { name, mimeType },
        signal: new AbortController().signal,
      });
    })().catch((error: unknown) =>
      Dialog.alert("Could not open file", error instanceof Error ? error.message : "Try again."),
    );
  };
}

type ImageEntry = {
  status: "pending" | "done" | "missing" | "waiting";
  expiresAt: number;
  url: string | null;
  /** The page could not load the URL it has; a returning connection mints a fresh one. */
  pageFailed: boolean;
};
export type NoteImageUrls = {
  readonly type: "imageUrls";
  readonly urls: Record<string, string>;
  readonly missing: string[];
};

// The live editor page is untrusted: these bound what it can make the app request.
const MAX_IMAGES = 200;
const MAX_IN_FLIGHT = 4;
const RENEW_WINDOW_MS = 5 * 60_000;

/**
 * Signs attachment images for one live editor page. Each href mints once; a renewal is honored only
 * near or past its URL's expiry (otherwise the page gets its URL back without a mint), unresolvable
 * hrefs are reported missing, and hrefs that failed for lack of a connection, or that the page
 * could not load, mint again when the connection returns.
 */
export function useNoteImageResolver(
  environmentId: EnvironmentId,
  notePath: string,
  send: (message: NoteImageUrls) => void,
) {
  const { mint, online } = useNoteFileMint(environmentId);
  const latest = useRef({ mint, send, online });
  // oxlint-disable-next-line goat/react-effect-budget -- WebView messages run outside render and need this render's mint.
  useLayoutEffect(() => {
    latest.current = { mint, send, online };
  });
  const entries = useRef(new Map<string, ImageEntry>());
  const queue = useRef<string[]>([]);
  const inFlight = useRef(0);
  const alive = useRef(true);
  // Counts returns to online, so a mint that failed across a reconnect is tried once more.
  const connection = useRef(0);
  const pump = () => {
    while (inFlight.current < MAX_IN_FLIGHT) {
      const href = queue.current.shift();
      if (href === undefined) return;
      const entry = entries.current.get(href);
      const path = resolveNoteFilePath(notePath, href);
      if (!entry || path === null) continue;
      inFlight.current++;
      const startedOn = connection.current;
      void latest.current.mint(path).then((minted) => {
        inFlight.current--;
        if (!alive.current) return;
        if (minted.ok) {
          entry.status = "done";
          entry.expiresAt = minted.expiresAt;
          entry.url = minted.url;
          entry.pageFailed = false;
          latest.current.send({ type: "imageUrls", urls: { [href]: minted.url }, missing: [] });
        } else if (minted.permanent) {
          entry.status = "missing";
          latest.current.send({ type: "imageUrls", urls: {}, missing: [href] });
        } else if (latest.current.online && startedOn !== connection.current) {
          entry.status = "pending";
          queue.current.push(href);
        } else entry.status = "waiting";
        pump();
      });
    }
  };
  // oxlint-disable-next-line goat/react-effect-budget -- results that arrive after the page is gone must be dropped.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const retryWaiting = useEffectEvent(() => {
    connection.current++;
    for (const [href, entry] of entries.current)
      if (entry.status === "waiting" || (entry.status === "done" && entry.pageFailed)) {
        entry.status = "pending";
        queue.current.push(href);
      }
    pump();
  });
  // oxlint-disable-next-line goat/react-effect-budget -- images that failed offline mint again when the connection returns.
  useEffect(() => {
    if (online) retryWaiting();
  }, [online]);
  return (hrefs: ReadonlyArray<string>, renew: boolean) => {
    const missing: string[] = [];
    for (const href of hrefs) {
      const entry = entries.current.get(href);
      if (entry === undefined) {
        if (entries.current.size >= MAX_IMAGES) continue;
        if (resolveNoteFilePath(notePath, href) === null) {
          entries.current.set(href, {
            status: "missing",
            expiresAt: 0,
            url: null,
            pageFailed: false,
          });
          missing.push(href);
          continue;
        }
        entries.current.set(href, {
          status: "pending",
          expiresAt: 0,
          url: null,
          pageFailed: false,
        });
        queue.current.push(href);
      } else if (renew && entry.status === "done") {
        if (entry.expiresAt - Date.now() <= RENEW_WINDOW_MS) {
          entry.status = "pending";
          queue.current.push(href);
        } else if (!latest.current.online) entry.status = "waiting";
        else {
          // Not an expiry: hand the URL back without minting, and mint afresh after a reconnect.
          entry.pageFailed = true;
          if (entry.url !== null)
            latest.current.send({ type: "imageUrls", urls: { [href]: entry.url }, missing: [] });
        }
      }
    }
    if (missing.length > 0) latest.current.send({ type: "imageUrls", urls: {}, missing });
    pump();
  };
}
