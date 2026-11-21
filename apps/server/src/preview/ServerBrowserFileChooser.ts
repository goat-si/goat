// @effect-diagnostics nodeBuiltinImport:off - Playwright callbacks run outside the Effect runtime.
import type { PreviewAutomationUploadInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import type { FileChooser } from "playwright-core";
import type { ServerBrowser } from "./ServerBrowser.ts";
import type { ServerTab } from "./ServerBrowserTab.ts";
import type { ServerBrowserViewerOutput } from "./ServerBrowserViewerOutput.ts";
import type { DispatchGate } from "./ServerBrowserPage.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { tabKey } from "./ServerBrowserPointer.ts";
import * as PreviewUpload from "./PreviewUpload.ts";

export const makeFileChoosers = (tabs: ReadonlyMap<string, ServerTab>) => {
  const fileChooserMessage = (tab: ServerTab): ServerBrowserViewerOutput | null =>
    tab.fileChooser
      ? {
          _tag: "fileChooser",
          id: tab.fileChooser.id,
          multiple: tab.fileChooser.chooser.isMultiple(),
          accept: tab.fileChooser.accept,
        }
      : null;

  // Not isConnected: upload helpers often click an input never added to the page. The handle's
  // context is destroyed with its document, so a replaced document rejects.
  const isFileChooserCurrent = (chooser: FileChooser) =>
    chooser
      .element()
      .evaluate(
        (element) =>
          element.ownerDocument === (globalThis as unknown as { document: unknown }).document,
      )
      .catch(() => false);

  const offerFileChooser = async (tab: ServerTab, chooser: FileChooser) => {
    const previous = tab.fileChooser;
    const accept =
      (await chooser
        .element()
        .getAttribute("accept")
        .catch(() => null)) ?? "";
    if (!(await isFileChooserCurrent(chooser))) return;
    if (previous) closeFileChooser(tab);
    tab.fileChooser = {
      id: NodeCrypto.randomUUID(),
      chooser,
      accept: accept.slice(0, 1024),
      offeredTo: null,
    };
    pushFileChooser(tab);
  };

  const pushFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
    if (!open || !controller) return;
    if (open.offeredTo !== controller.id) {
      tab.fileChooser = { ...open, id: NodeCrypto.randomUUID(), offeredTo: controller.id };
      if (open.offeredTo !== null)
        for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
    }
    const message = fileChooserMessage(tab);
    if (message) controller.push(message);
  };

  const closeFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    if (!open) return;
    tab.fileChooser = null;
    for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
  };

  const setChooserFiles = async (
    input: Parameters<ServerBrowser["Service"]["answerFileChooser"]>[0],
  ) => {
    const tab = tabs.get(tabKey(input.threadId, input.tabId));
    const open = tab?.fileChooser;
    if (
      !tab ||
      !open ||
      open.id !== input.chooserId ||
      open.offeredTo === null ||
      open.offeredTo !== tab.control.controller
    )
      return false;
    if (input.files.length > 0) {
      await open.chooser.setFiles(
        open.chooser.isMultiple() ? [...input.files] : input.files.slice(0, 1),
      );
    }
    if (tab.fileChooser === open) closeFileChooser(tab);
    return true;
  };
  const uploadFiles = async (
    tab: ServerTab,
    input: PreviewAutomationUploadInput,
    gate: DispatchGate,
  ) => {
    await PreviewUpload.validatePaths(input.paths);
    if (await PreviewUpload.setInputFiles(tab.page, tab.cdp, input, gate)) return undefined;
    const open = tab.fileChooser;
    if (!open)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
      );
    if (input.paths.length > 1 && !open.chooser.isMultiple())
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This file picker accepts one file.",
      );
    if (input.paths.length > 0) {
      const channel = gate.channel;
      if (!channel) throw new Error("An action channel is required for upload.");
      const element = await channel.call(() => open.chooser.element());
      try {
        await PreviewUpload.uploadInto(tab.cdp, element, input.paths, gate);
      } finally {
        if (!gate.signal?.aborted) void channel.dispose(element).catch(constVoid);
      }
    } else await gate();
    if (tab.fileChooser === open) closeFileChooser(tab);
    return undefined;
  };

  const answerFileChooser: ServerBrowser["Service"]["answerFileChooser"] = (input) =>
    Effect.promise(() => setChooserFiles(input).catch(() => false));

  return {
    answerFileChooser,
    closeFileChooser,
    isFileChooserCurrent,
    offerFileChooser,
    pushFileChooser,
    uploadFiles,
  };
};
