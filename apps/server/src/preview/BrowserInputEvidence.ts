import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";
import { readOnly, type ActionChannel } from "./actionChannel.ts";

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

const isContextCreated = Schema.is(Schema.Struct({ context: Schema.Struct({ id: Schema.Int }) }));
const isContextDestroyed = Schema.is(Schema.Struct({ executionContextId: Schema.Int }));

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

export async function startBrowserInputEvidence(page: Page, channel: ActionChannel) {
  const cdp = await Promise.resolve()
    .then(() => channel.newCDPSession(page))
    .catch(() => undefined);
  if (cdp === undefined) return hidden();
  const send = channel.sendFor(cdp);
  let navigated = false;
  let contextsChanged = false;
  let stable = false;
  const contexts = new Set<number>();
  const onCreated = (event: unknown) => {
    if (!isContextCreated(event)) {
      contextsChanged = true;
      return;
    }
    if (stable && !contexts.has(event.context.id)) contextsChanged = true;
    contexts.add(event.context.id);
  };
  const onDestroyed = (event: unknown) => {
    if (!isContextDestroyed(event)) {
      contextsChanged = true;
      return;
    }
    if (stable) contextsChanged = true;
    contexts.delete(event.executionContextId);
  };
  const onCleared = () => {
    if (stable) contextsChanged = true;
    contexts.clear();
  };
  cdp.on("Runtime.executionContextCreated", onCreated);
  cdp.on("Runtime.executionContextDestroyed", onDestroyed);
  cdp.on("Runtime.executionContextsCleared", onCleared);
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
  const otherWindows: Array<string> = [];
  let focusId: string | undefined;
  const release = async (id: string | undefined) => {
    if (id !== undefined)
      await Promise.resolve()
        .then(() => send("Runtime.releaseObject", { objectId: id }))
        .catch(() => {});
  };
  const cleanup = async () => {
    page.off("framenavigated", onNavigate);
    page.off("frameattached", onNavigate);
    page.off("framedetached", onNavigate);
    cdp.off("Page.frameStartedLoading", onNavigate);
    cdp.off("Page.navigatedWithinDocument", onNavigate);
    cdp.off("Runtime.executionContextCreated", onCreated);
    cdp.off("Runtime.executionContextDestroyed", onDestroyed);
    cdp.off("Runtime.executionContextsCleared", onCleared);
    const monitor = monitorId;
    if (monitor !== undefined)
      await Promise.resolve()
        .then(() =>
          send("Runtime.callFunctionOn", {
            objectId: monitor,
            functionDeclaration: "function(){return this.finish()}",
            returnByValue: true,
          }),
        )
        .catch(() => {});
    await Promise.all([
      release(monitorId),
      release(windowId),
      ...otherWindows.map(release),
      release(focusId),
    ]);
    await Promise.resolve()
      .then(() => channel.detach(cdp))
      .catch(() => {});
  };
  try {
    if (channel.read(readOnly(() => page.frames().length)) !== 1) {
      await cleanup();
      return hidden();
    }
    await send("Runtime.enable");
    await send("Page.enable");
    const tree = await send("Page.getFrameTree");
    const world = await send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "goat-input-history",
    });
    const window = await send("Runtime.evaluate", {
      expression: "window",
      contextId: world.executionContextId,
    });
    windowId = window.result.objectId;
    if (windowId === undefined) {
      await cleanup();
      return hidden();
    }
    contexts.add(world.executionContextId);
    if (contexts.size > 16) {
      await cleanup();
      return hidden();
    }
    stable = true;
    const captureListeners = async (id: string) =>
      (await send("DOMDebugger.getEventListeners", { objectId: id })).listeners.filter(
        (listener) =>
          listener.useCapture && (listener.type === "beforeinput" || listener.type === "input"),
      );
    for (const contextId of contexts) {
      if (contextId === world.executionContextId) continue;
      const other = await send("Runtime.evaluate", { expression: "window", contextId });
      if (other.result.objectId === undefined || other.exceptionDetails !== undefined) {
        await cleanup();
        return hidden();
      }
      otherWindows.push(other.result.objectId);
      if ((await captureListeners(other.result.objectId)).length > 0) {
        await cleanup();
        return hidden();
      }
    }
    if (contextsChanged || (await captureListeners(windowId)).length > 0) {
      await cleanup();
      return hidden();
    }
    const focus = await send("Runtime.evaluate", {
      expression: "document.activeElement",
      contextId: world.executionContextId,
    });
    focusId = focus.result.objectId;
    if (focusId === undefined) {
      await cleanup();
      return hidden();
    }
    const focused = await send("DOM.describeNode", {
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
    const installed = await send("Runtime.evaluate", {
      expression: MONITOR,
      contextId: world.executionContextId,
    });
    monitorId = installed.result.objectId;
    if (monitorId === undefined || installed.exceptionDetails !== undefined) {
      await cleanup();
      return hidden();
    }
    const installedListeners = await send("DOMDebugger.getEventListeners", {
      objectId: windowId,
    });
    const count = (type: string) =>
      installedListeners.listeners.filter(
        (listener) => listener.useCapture && listener.type === type,
      ).length;
    if (
      count("beforeinput") !== 1 ||
      count("input") !== 1 ||
      contextsChanged ||
      (await Promise.all(otherWindows.map(captureListeners))).some(
        (listeners) => listeners.length > 0,
      )
    ) {
      await cleanup();
      return hidden();
    }
    const monitoredObject = monitorId;
    const focusedObject = focusId;
    return {
      finish: async () => {
        try {
          const answer = await send("Runtime.callFunctionOn", {
            objectId: monitoredObject,
            functionDeclaration: "function(){return this.finish()}",
            returnByValue: true,
          });
          const focusedAfter = await send("DOM.describeNode", {
            objectId: focusedObject,
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
            channel.read(readOnly(() => page.frames().length)) !== 1 ||
            addedShadow ||
            contextsChanged ||
            (await Promise.all(otherWindows.map(captureListeners))).some(
              (listeners) => listeners.length > 0,
            ) ||
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
