import type { AssetResource, EnvironmentId } from "@goat/contracts";
import { useRef, useState } from "react";
import { useAssetUrlRefresh, useAssetUrlState } from "../assets/assetUrls";

type NoteFileResource = Extract<AssetResource, { readonly _tag: "note-file" }>;

/**
 * A signed URL for a file embedded in a note. A failed load re-mints once, since the usual cause is
 * an expired URL in a note left open; a second failure in a row waits for the person to retry, so a
 * file that is gone cannot mint and reload forever. Any successful load restores the retry.
 */
export function useNoteFileUrl(environmentId: EnvironmentId | null, path: string | null) {
  const resource: NoteFileResource | null = path === null ? null : { _tag: "note-file", path };
  const minted = useAssetUrlState(environmentId, resource);
  const refresh = useAssetUrlRefresh(environmentId, resource);
  const [fresh, setFresh] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const remint = () =>
    refresh().then(
      (next) => (next === null ? setFailed(true) : setFresh(next)),
      () => setFailed(true),
    );
  return {
    url: failed ? null : (fresh ?? (minted._tag === "Success" ? minted.url : null)),
    failed: failed || minted._tag === "Failure",
    onLoad: () => {
      retried.current = false;
    },
    onError: () => {
      if (retried.current) {
        setFailed(true);
        return;
      }
      retried.current = true;
      void remint();
    },
    retry: () => {
      retried.current = true;
      setFailed(false);
      void remint();
    },
  };
}

/** Mints a download URL only when asked, so a chip never holds one that expired. */
export function useNoteFileDownload(environmentId: EnvironmentId | null, path: string | null) {
  return useAssetUrlRefresh(
    environmentId,
    path === null ? null : { _tag: "note-file", path, disposition: "attachment" },
  );
}
