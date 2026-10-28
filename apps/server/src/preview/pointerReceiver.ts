// @effect-diagnostics globalTimers:off - Playwright calls run outside the Effect runtime.
/**
 * Names what receives the pointer at an intercepted target's center: tag, role and an id or
 * class hint, never page text. It starts in the top document, so a cover over a frame is named.
 */
import type { ElementHandle, Frame, Locator, Page } from "playwright-core";

const MAX_FRAME_DEPTH = 5;
/** Identifiers only; long runs of letters and digits look like tokens and are left out. */
const IDENTIFIER = /^[A-Za-z][\w-]{0,39}$/;
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}|\d{6,}/;
const ROLE = /^[a-z]{1,20}$/;

const usable = (token: string) => IDENTIFIER.test(token) && !TOKEN_LIKE.test(token);

/** The topmost element at a point, inside open shadow roots too. */
const HIT_AT = `([x, y]) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}`;

const within = async <A>(work: Promise<A>, deadline: number): Promise<A | undefined> => {
  void work.catch(() => undefined);
  const left = deadline - performance.now();
  if (left <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const describe = (element: ElementHandle) =>
  element.evaluate((node) => {
    const target = node as unknown as {
      readonly tagName: string;
      readonly id: string;
      readonly classList: Iterable<string>;
      getAttribute(name: string): string | null;
    };
    return {
      tag: target.tagName.toLowerCase(),
      role: (target.getAttribute("role") ?? "").toLowerCase(),
      id: target.id,
      classes: Array.from(target.classList).slice(0, 3),
    };
  });

const receiverAt = async (page: Page, x: number, y: number) => {
  let frame: Frame = page.mainFrame();
  let origin = { x: 0, y: 0 };
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    const hit = await frame.evaluateHandle(
      `(${HIT_AT})(${JSON.stringify([x - origin.x, y - origin.y])})`,
    );
    const element = hit.asElement();
    if (element === null) {
      void hit.dispose().catch(() => undefined);
      return undefined;
    }
    try {
      const inner = await element.contentFrame();
      if (inner === null) return await describe(element);
      // Frame boxes are in top-document coordinates, so the point maps straight into the frame.
      const box = await element.boundingBox();
      if (box === null) return undefined;
      origin = { x: box.x, y: box.y };
      frame = inner;
    } finally {
      void element.dispose().catch(() => undefined);
    }
  }
  return undefined;
};

/** "<div> (dialog) #cookie-banner", or undefined when nothing safe can be said in time. */
export const describeReceiver = async (page: Page, target: Locator, deadline: number) => {
  try {
    const box = await within(target.boundingBox(), deadline);
    if (!box) return undefined;
    const found = await within(
      receiverAt(page, box.x + box.width / 2, box.y + box.height / 2),
      deadline,
    );
    if (!found) return undefined;
    const hint = usable(found.id)
      ? ` #${found.id}`
      : found.classes
          .filter(usable)
          .map((name) => `.${name}`)
          .join("");
    const role = ROLE.test(found.role) ? ` (${found.role})` : "";
    const tag = /^[a-z][a-z0-9-]{0,30}$/.test(found.tag) ? found.tag : "element";
    return `<${tag}>${role}${hint ? ` ${hint.trim()}` : ""}`;
  } catch {
    return undefined;
  }
};
