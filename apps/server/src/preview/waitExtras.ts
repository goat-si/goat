import type { Page } from "playwright-core";
import { constVoid } from "effect/Function";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import type { DownloadWait, SavedDownload } from "./downloadJournal.ts";
import { matchesUrlGlob } from "./urlGlob.ts";

/**
 * The URL glob and download conditions a wait adds, both read in Node and never in the page: the
 * main frame's URL as Playwright tracks it, and the tab's download journal.
 */
export const extraWaits = (
  page: Page,
  input: { readonly urlGlob?: string | undefined; readonly download?: true | undefined },
  downloads: DownloadWait | undefined,
) => {
  const { urlGlob } = input;
  const ended = new AbortController();
  let found: { readonly file: SavedDownload; readonly claim: () => void } | undefined;
  const download =
    input.download === undefined
      ? undefined
      : downloads === undefined
        ? Promise.reject(
            new ServerBrowserOperationError(
              "PreviewAutomationExecutionError",
              "A download wait needs the server browser's download journal.",
            ),
          )
        : downloads.journal
            .wait(downloads.since, ended.signal, downloads.kept, downloads.claims)
            .then((each) => {
              found = each;
            });
  // It can fail after the wait already ended another way; that is no unhandled rejection.
  void download?.catch(constVoid);
  return {
    names: [...(urlGlob === undefined ? [] : ["url glob"]), ...(download ? ["download"] : [])],
    /** What one pass of the wait awaits; a URL wait settles at once while the URL matches. */
    pending: (timeout: number) => [
      ...(urlGlob === undefined
        ? []
        : [
            page.waitForURL((url) => matchesUrlGlob(urlGlob, url.href), {
              waitUntil: "commit",
              timeout,
            }),
          ]),
      ...(download ? [download] : []),
    ],
    held: () =>
      (urlGlob === undefined || matchesUrlGlob(urlGlob, page.url())) &&
      (download === undefined || found !== undefined),
    /** Once every condition held: takes the download, so the next wait gets the next one. */
    finish: () => {
      // A wait that already timed out or was stopped can still reach here; it answered, so it takes nothing.
      if (found === undefined || ended.signal.aborted) return {};
      // A screen-code wait whose tab changed under it fails here, before taking anything.
      downloads?.confirm?.();
      if (downloads?.claims) found.claim();
      const { fileName, path, sizeBytes, url, completedAt } = found.file;
      return { download: { fileName, path, sizeBytes, url, completedAt } };
    },
    end: () => ended.abort(),
  };
};
