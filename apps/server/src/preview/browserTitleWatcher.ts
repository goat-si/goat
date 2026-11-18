import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

export const BROWSER_TITLE_LIMIT = 512;
const TITLE_WORLD = "goat-preview-title";
let sequence = 0;

// The isolated world keeps observers off the page's globals and away from body subtree changes.
const waitForTitle = (title: string, key: string) => `new Promise((resolve) => {
  const key = ${JSON.stringify(key)};
  const changed = () => document.title.slice(0, ${BROWSER_TITLE_LIMIT}) !== ${JSON.stringify(title)};
  if (changed()) return resolve(true);
  let root;
  let head;
  let element;
  const finish = (changed) => {
    observer.disconnect();
    delete globalThis[key];
    resolve(changed);
  };
  const observer = new MutationObserver(() => {
    if (changed()) finish(true);
    else if (root !== document.documentElement || head !== document.head || element !== document.querySelector("title")) bind();
  });
  const bind = () => {
    observer.disconnect();
    observer.observe(document, { childList: true });
    root = document.documentElement;
    head = document.head;
    element = document.querySelector("title");
    if (root) observer.observe(root, { childList: true });
    if (head) observer.observe(head, { childList: true, subtree: true, characterData: true });
    if (element && !head?.contains(element)) {
      observer.observe(element, { childList: true, subtree: true, characterData: true });
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        observer.observe(parent, { childList: true });
      }
    }
  };
  globalThis[key] = () => finish(false);
  bind();
})`;

export const makeBrowserTitleWatcher = (cdp: CDPSession, checkRead: () => boolean) => {
  const canRead = () => {
    try {
      return checkRead();
    } catch {
      return false;
    }
  };
  let active: { document: number; key: string; contextId?: number } | undefined;
  let deferred: typeof active;
  let retiring: Promise<void> | undefined;
  const stop = () => {
    const previous = active?.contextId === undefined ? deferred : active;
    active = undefined;
    if (previous?.contextId === undefined) return;
    if (!canRead()) {
      deferred = previous;
      return;
    }
    deferred = undefined;
    const cleanup = cdp
      .send("Runtime.evaluate", {
        contextId: previous.contextId,
        expression: `globalThis[${JSON.stringify(previous.key)}]?.()`,
      })
      .then(constVoid, constVoid);
    retiring = cleanup;
    void cleanup.then(() => {
      if (retiring === cleanup) retiring = undefined;
    });
  };
  const watch = async (document: number, title: string, onChanged: () => Promise<void>) => {
    if (active?.document === document || !canRead()) return;
    stop();
    if (deferred) return;
    const token: NonNullable<typeof active> = { document, key: `goatPreviewTitle${++sequence}` };
    active = token;
    try {
      await retiring;
      if (active !== token) return;
      if (!canRead()) {
        active = undefined;
        return;
      }
      const { frameTree } = await cdp.send("Page.getFrameTree");
      if (active !== token) return;
      if (!canRead()) {
        active = undefined;
        return;
      }
      const world = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: TITLE_WORLD,
      });
      if (active !== token) return;
      if (!canRead()) {
        active = undefined;
        return;
      }
      token.contextId = world.executionContextId;
      void cdp
        .send("Runtime.evaluate", {
          contextId: token.contextId,
          expression: waitForTitle(title, token.key),
          awaitPromise: true,
          returnByValue: true,
        })
        .then(
          ({ result, exceptionDetails }) => {
            if (deferred === token) deferred = undefined;
            if (active !== token) return;
            active = undefined;
            if (!exceptionDetails && result.value === true && canRead()) return onChanged();
          },
          () => {
            if (deferred === token) deferred = undefined;
            if (active === token) active = undefined;
          },
        )
        .catch(constVoid);
    } catch {
      if (active === token) active = undefined;
    }
  };
  return { watch, stop };
};
