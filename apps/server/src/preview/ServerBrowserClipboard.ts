import { constVoid } from "effect/Function";
import type { CDPSession, Frame, Page } from "playwright-core";
import * as ViewerInput from "./ServerBrowserViewerInput.ts";
import { openSetupSend } from "./openRunSignals.ts";

interface ClipboardTab {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: Map<Frame, CDPSession>;
}

export const recordCopies = async (cdp: CDPSession, signal?: AbortSignal) => {
  const send = openSetupSend(cdp, signal);
  // Scripts for new documents run only while this session's Page domain is on.
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: ViewerInput.CLIPBOARD_SCRIPT,
    worldName: ViewerInput.CLIPBOARD_WORLD,
    runImmediately: true,
  });
};

/** Out-of-process frames need their own copy-recording session until target closure. */
export const recordFrameCopies = async (tab: ClipboardTab, frame: Frame) => {
  if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) return;

  const cdp = await tab.page
    .context()
    .newCDPSession(frame)
    .catch(() => null);
  if (!cdp) return;
  if (tab.frameSessions.has(frame) || frame.isDetached()) {
    await cdp.detach().catch(constVoid);
    return;
  }
  tab.frameSessions.set(frame, cdp);
  cdp.on("close", () => {
    if (tab.frameSessions.get(frame) !== cdp) return;
    tab.frameSessions.delete(frame);

    if (!frame.isDetached()) void recordFrameCopies(tab, frame);
  });
  await recordCopies(cdp).catch(constVoid);
};

const takeSessionCopies = async (cdp: CDPSession) => {
  const tree = await cdp.send("Page.getFrameTree").catch(() => null);
  if (!tree) return [];
  const frameIds = (node: typeof tree.frameTree): Array<string> => [
    node.frame.id,
    ...(node.childFrames ?? []).flatMap(frameIds),
  ];
  return Promise.all(
    frameIds(tree.frameTree).map((frameId) =>
      cdp
        .send("Page.createIsolatedWorld", { frameId, worldName: ViewerInput.CLIPBOARD_WORLD })
        .then(({ executionContextId }) =>
          cdp.send("Runtime.evaluate", {
            contextId: executionContextId,
            expression: "globalThis.takeCopy?.()",
            returnByValue: true,
          }),
        )
        .then(
          ({ result }) => (typeof result.value === "string" ? result.value : ""),
          () => "",
        ),
    ),
  );
};

export const takeCopiedText = async (tab: ClipboardTab) => {
  const copies = await Promise.all([tab.cdp, ...tab.frameSessions.values()].map(takeSessionCopies));
  return copies.flat().find((text) => text.length > 0);
};
