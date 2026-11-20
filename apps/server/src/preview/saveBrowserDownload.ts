// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Playwright download callbacks run outside Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { constVoid } from "effect/Function";
import type { Download } from "playwright-core";
import { artifactFileName, publishArtifact } from "./browserArtifacts.ts";
import * as ServerBrowserLimits from "./serverBrowserLimits.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import type { ServerDownload, ServerTab } from "./ServerBrowserTab.ts";

export const makeSaveDownload =
  (options: {
    readonly directory: string;
    readonly clearAbortedNavigation: (tab: ServerTab) => void;
    readonly settleAbortedNavigation: (
      tab: ServerTab,
      generation: number,
      url: string,
      offered: { readonly id: string; readonly fileName: string } | undefined,
    ) => void;
    readonly reportFailure: (cause: unknown) => void;
  }) =>
  async (tab: ServerTab, download: Download) => {
    const id = NodeCrypto.randomUUID();
    let path: string | undefined;
    const navigation =
      download.url() === tab.abortedNavigation?.url ? tab.abortedNavigation.generation : null;
    if (navigation !== null) options.clearAbortedNavigation(tab);
    let offered: { readonly id: string; readonly fileName: string } | undefined;
    try {
      if (await download.failure()) return;
      // A saved download outlives its tab until storage cleanup, like a screenshot.
      const suggestedName = download.suggestedFilename();
      path = await publishArtifact(
        options.directory,
        artifactFileName("download", download.url(), { suggestedName }),
        (target) => download.saveAs(target),
      );
      const { size } = await NodeFSP.stat(path);
      if (tab.closing || size > ServerBrowserLimits.DOWNLOAD_MAX_BYTES) {
        await NodeFSP.rm(path, { force: true });
        return;
      }
      const saved: ServerDownload = {
        id,
        fileName: suggestedName.slice(0, 255) || "download",
        path,
        sizeBytes: size,
        url: ServerBrowserPage.withoutDataPayload(download.url()).slice(0, 2048),
        completedAt: new Date().toISOString(),
      };
      tab.downloads.push(saved);
      for (const evicted of tab.downloads.splice(
        0,
        tab.downloads.length - ServerBrowserLimits.DOWNLOAD_LIMIT,
      )) {
        await NodeFSP.rm(evicted.path, { force: true }).catch(constVoid);
      }
      offered = { id, fileName: saved.fileName };
      const shownInTab =
        navigation === tab.navigationGeneration && tab.page.url() === "about:blank";
      if (shownInTab) return saved;
      const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
      controller?.push({
        _tag: "download",
        id,
        fileName: saved.fileName,
        sizeBytes: saved.sizeBytes,
      });
      return saved;
    } catch (cause) {
      if (path !== undefined) await NodeFSP.rm(path, { force: true }).catch(constVoid);
      options.reportFailure(cause);
    } finally {
      if (navigation !== null && !tab.closing) {
        options.settleAbortedNavigation(tab, navigation, download.url(), offered);
      }
      // saveAs copies the artifact; cached profile contexts otherwise retain the original.
      await download.delete().catch(constVoid);
    }
  };
