import * as Schema from "effect/Schema";
import type { CDPSession, Page } from "playwright-core";

const isEvidence = Schema.is(
  Schema.Struct({
    overflow: Schema.Boolean,
    events: Schema.Array(
      Schema.Struct({
        type: Schema.Literals(["beforeinput", "input"]),
        trusted: Schema.Boolean,
        normal: Schema.Boolean,
        token: Schema.Int,
      }),
    ),
  }),
);

const MONITOR = `(() => {
  let next = 1, overflow = false;
  const ids = new WeakMap(), events = [];
  const normal = element => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const tokens = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
    if (tokens.some(token => /^(?:one-time-code|cc-.*|current-password|new-password)$/.test(token))) return false;
    const mask = getComputedStyle(element).getPropertyValue("-webkit-text-security");
    if (mask && mask !== "none") return false;
    if (element.disabled || element.readOnly || element.matches(":disabled")) return false;
    if (element instanceof HTMLInputElement) return ["text", "search", "url", "email", "tel"].includes(element.type);
    return element instanceof HTMLTextAreaElement || element.isContentEditable === true;
  };
  const observe = event => {
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) { overflow = true; return; }
    if (events.length >= 128) { overflow = true; return; }
    if (!ids.has(target)) ids.set(target, next++);
    events.push({ type: event.type, trusted: event.isTrusted, normal: normal(target), token: ids.get(target) });
  };
  window.addEventListener("beforeinput", observe, true);
  window.addEventListener("input", observe, true);
  return { finish() {
    window.removeEventListener("beforeinput", observe, true);
    window.removeEventListener("input", observe, true);
    return { overflow, events };
  } };
})()`;

const hidden = () => ({ finish: async () => false });

export async function startBrowserInputEvidence(page: Page, cdp: CDPSession) {
  let navigated = false;
  const onNavigate = () => {
    navigated = true;
  };
  page.on("framenavigated", onNavigate);
  page.on("frameattached", onNavigate);
  page.on("framedetached", onNavigate);
  cdp.on("Page.frameStartedLoading", onNavigate);
  cdp.on("Page.navigatedWithinDocument", onNavigate);
  let monitorId: string | undefined;
  let windowId: string | undefined;
  let mainWindowId: string | undefined;
  let focusId: string | undefined;
  const release = async (id: string | undefined) => {
    if (id !== undefined) await cdp.send("Runtime.releaseObject", { objectId: id }).catch(() => {});
  };
  const cleanup = async () => {
    page.off("framenavigated", onNavigate);
    page.off("frameattached", onNavigate);
    page.off("framedetached", onNavigate);
    cdp.off("Page.frameStartedLoading", onNavigate);
    cdp.off("Page.navigatedWithinDocument", onNavigate);
    if (monitorId !== undefined)
      await cdp
        .send("Runtime.callFunctionOn", {
          objectId: monitorId,
          functionDeclaration: "function(){return this.finish()}",
          returnByValue: true,
        })
        .catch(() => {});
    await Promise.all([
      release(monitorId),
      release(windowId),
      release(mainWindowId),
      release(focusId),
    ]);
  };
  try {
    if (page.frames().length !== 1) {
      await cleanup();
      return hidden();
    }
    await cdp.send("Page.enable");
    const tree = await cdp.send("Page.getFrameTree");
    const world = await cdp.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "goat-input-history",
    });
    const window = await cdp.send("Runtime.evaluate", {
      expression: "window",
      contextId: world.executionContextId,
    });
    windowId = window.result.objectId;
    if (windowId === undefined) {
      await cleanup();
      return hidden();
    }
    const mainWindow = await cdp.send("Runtime.evaluate", { expression: "window" });
    mainWindowId = mainWindow.result.objectId;
    if (mainWindowId === undefined) {
      await cleanup();
      return hidden();
    }
    const captureListeners = async (id: string) =>
      (await cdp.send("DOMDebugger.getEventListeners", { objectId: id })).listeners.filter(
        (listener) =>
          listener.useCapture && (listener.type === "beforeinput" || listener.type === "input"),
      );
    if (
      (await captureListeners(windowId)).length > 0 ||
      (await captureListeners(mainWindowId)).length > 0
    ) {
      await cleanup();
      return hidden();
    }
    const focus = await cdp.send("Runtime.evaluate", {
      expression: "document.activeElement",
      contextId: world.executionContextId,
    });
    focusId = focus.result.objectId;
    if (focusId === undefined) {
      await cleanup();
      return hidden();
    }
    const focused = await cdp.send("DOM.describeNode", {
      objectId: focusId,
      depth: 1,
      pierce: true,
    });
    if (
      (focused.node.shadowRoots?.length ?? 0) > 0 &&
      focused.node.nodeName !== "INPUT" &&
      focused.node.nodeName !== "TEXTAREA"
    ) {
      await cleanup();
      return hidden();
    }
    const installed = await cdp.send("Runtime.evaluate", {
      expression: MONITOR,
      contextId: world.executionContextId,
    });
    monitorId = installed.result.objectId;
    if (monitorId === undefined || installed.exceptionDetails !== undefined) {
      await cleanup();
      return hidden();
    }
    const installedListeners = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: windowId,
    });
    const count = (type: string) =>
      installedListeners.listeners.filter(
        (listener) => listener.useCapture && listener.type === type,
      ).length;
    if (
      count("beforeinput") !== 1 ||
      count("input") !== 1 ||
      (await captureListeners(mainWindowId)).length > 0
    ) {
      await cleanup();
      return hidden();
    }
    return {
      finish: async () => {
        try {
          const answer = await cdp.send("Runtime.callFunctionOn", {
            objectId: monitorId,
            functionDeclaration: "function(){return this.finish()}",
            returnByValue: true,
          });
          const focusedAfter = await cdp.send("DOM.describeNode", {
            objectId: focusId,
            depth: 1,
            pierce: true,
          });
          const addedShadow =
            (focusedAfter.node.shadowRoots?.length ?? 0) > 0 &&
            focusedAfter.node.nodeName !== "INPUT" &&
            focusedAfter.node.nodeName !== "TEXTAREA";
          const evidence: unknown = answer.result.value;
          if (
            navigated ||
            page.frames().length !== 1 ||
            addedShadow ||
            (await captureListeners(mainWindowId)).length > 0 ||
            answer.exceptionDetails !== undefined ||
            !isEvidence(evidence) ||
            evidence.overflow
          )
            return false;
          const trusted = evidence.events.filter((event) => event.trusted);
          return (
            trusted.some((event) => event.type === "input") &&
            trusted.every((event) => event.normal && event.token === trusted[0]?.token) &&
            evidence.events.every((event) => event.trusted || event.normal)
          );
        } catch {
          return false;
        } finally {
          await cleanup();
        }
      },
    };
  } catch {
    await cleanup();
    return hidden();
  }
}
