// @effect-diagnostics nodeBuiltinImport:off - overlay identities belong to the browser callback.
import * as NodeCrypto from "node:crypto";
import type { Page } from "playwright-core";

export const withRefAnnotations = async <A>(
  page: Page,
  tree: string,
  capture: () => Promise<A>,
) => {
  const boxes = [...tree.matchAll(/\[ref=([^\]]+)\][^\n]*?\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/g)]
    .slice(0, 300)
    .map((match) => ({ ref: match[1], x: Number(match[2]), y: Number(match[3]) }));
  const id = `goat-ref-overlay-${NodeCrypto.randomUUID()}`;
  try {
    await page.evaluate(`(() => {
      const overlay = document.createElement('div');
      overlay.id = ${JSON.stringify(id)};
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const root = overlay.attachShadow({mode:'closed'});
      for (const box of ${JSON.stringify(boxes)}) {
        const label = document.createElement('span');
        label.textContent = box.ref;
        label.style.cssText = 'position:absolute;background:#ffeb00;color:#000;font:12px monospace;padding:2px;white-space:nowrap';
        label.style.left = Math.max(0,box.x) + 'px'; label.style.top = Math.max(0,box.y) + 'px';
        root.append(label);
      }
      document.documentElement.append(overlay);
    })()`);
    return await capture();
  } finally {
    if (!page.isClosed())
      await page.evaluate(`document.getElementById(${JSON.stringify(id)})?.remove()`);
  }
};
