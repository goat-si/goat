// @effect-diagnostics globalDate:off - Playwright input runs outside the Effect runtime.
import { constVoid } from "effect/Function";
import type { CDPSession, Frame, Page } from "playwright-core";
import * as ViewerInput from "./ServerBrowserViewerInput.ts";
import { sleepUntil } from "./ServerBrowserPointer.ts";
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
export const recordFrameCopies = async (
  tab: ClipboardTab,
  frame: Frame,
  signal?: AbortSignal,
  retrySignal?: () => AbortSignal | undefined,
) => {
  signal?.throwIfAborted();
  if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) return;

  const cdp = await tab.page
    .context()
    .newCDPSession(frame)
    .catch(() => null);
  if (!cdp) return;
  signal?.throwIfAborted();
  if (tab.frameSessions.has(frame) || frame.isDetached()) {
    await cdp.detach().catch(constVoid);
    return;
  }
  tab.frameSessions.set(frame, cdp);
  cdp.on("close", () => {
    if (tab.frameSessions.get(frame) !== cdp) return;
    tab.frameSessions.delete(frame);

    const nextSignal = retrySignal ? retrySignal() : signal;
    if (!frame.isDetached() && !nextSignal?.aborted)
      void recordFrameCopies(tab, frame, nextSignal, retrySignal).catch(constVoid);
  });
  await recordCopies(cdp, signal).catch((cause: unknown) => {
    if (signal?.aborted) throw cause;
  });
};

const takeSessionCopies = async (cdp: CDPSession, since: number, until: number) => {
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
            expression: `globalThis.takeCopy?.(${since}, ${until})`,
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

export const takeCopiedText = async (tab: ClipboardTab, since: number, until: number) => {
  const copies = await Promise.all(
    [tab.cdp, ...tab.frameSessions.values()].map((cdp) => takeSessionCopies(cdp, since, until)),
  );
  return copies.flat().find((text) => text.length > 0);
};

export const dispatchViewerKey = async (
  tab: ClipboardTab & {
    desktop: unknown;
    copyReads: Promise<void>;
    copyKeyedUntil: number;
    pendingCopyReads: number;
  },
  session: CDPSession,
  viewer: {
    pressedKeys: Map<string, { key: string; code: string }>;
    push: (output: import("./ServerBrowser.ts").ServerBrowserViewerOutput) => void;
  },
  message: Record<string, unknown>,
  modifiers: number,
) => {
  const key = typeof message.key === "string" ? message.key : "";
  const code = typeof message.code === "string" ? message.code : "";
  const text = typeof message.text === "string" ? message.text : undefined;
  if (message.action === "up") {
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
    viewer.pressedKeys.delete(code || key);
    return;
  }
  const command = ViewerInput.editingCommand(key, modifiers);
  const copying =
    !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");
  if (copying && tab.pendingCopyReads >= 128) await tab.copyReads;
  if (copying) while (Date.now() <= tab.copyKeyedUntil) await sleepUntil(tab.copyKeyedUntil + 1);
  const since = Date.now();
  await session.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key,
    code,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
    ...command,
    windowsVirtualKeyCode: ViewerInput.num(
      message.keyCode,
      key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    ),
  });
  viewer.pressedKeys.set(code || key, { key, code });
  if (!copying) return;
  const until = Date.now();
  tab.copyKeyedUntil = until;
  tab.pendingCopyReads++;
  const read = tab.copyReads
    .then(async () => {
      const copied = await takeCopiedText(tab, since, until);
      if (copied) viewer.push({ _tag: "clipboard", text: copied });
    })
    .finally(() => {
      tab.pendingCopyReads--;
    });
  tab.copyReads = read;
  return () => read;
};
