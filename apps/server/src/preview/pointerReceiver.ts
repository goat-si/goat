// @effect-diagnostics globalTimers:off - Playwright calls run outside the Effect runtime.
/**
 * Names what receives the pointer at an intercepted target's center: tag, role and an id or
 * class hint, never page text. It starts in the top document, so a cover over a frame is named.
 */
import type { ElementHandle, Frame, Locator, Page } from "playwright-core";
import { redactCookieValues } from "./cookieValues.ts";
import { tabCookies } from "./pageSecrets.ts";

const MAX_FRAME_DEPTH = 5;
/** Identifiers only; long runs of letters and digits look like tokens and are left out. */
const IDENTIFIER = /^[A-Za-z][\w-]{0,39}$/;
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}|\d{6,}/;
const ROLE = /^[a-z]{1,20}$/;

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

/** Tag, role and identifiers; one that holds a password field's value in its document is dropped. */
const describe = (element: ElementHandle) =>
  element.evaluate((node) => {
    const target = node as unknown as {
      readonly tagName: string;
      readonly id: string;
      readonly classList: Iterable<string>;
      readonly ownerDocument: { querySelectorAll(selector: string): Iterable<{ value: string }> };
      getAttribute(name: string): string | null;
    };
    const hidden = Array.from(target.ownerDocument.querySelectorAll("input[type=password]"))
      .map((input) => input.value)
      .filter((value) => value.length >= 3);
    const clean = (token: string) => !hidden.some((value) => token.includes(value));
    return {
      tag: target.tagName.toLowerCase(),
      role: (target.getAttribute("role") ?? "").toLowerCase(),
      identifiers: [
        target.id,
        ...Array.from(target.classList)
          .slice(0, 3)
          .map((name) => `.${name}`),
      ].filter((token) => token !== "" && clean(token.replace(/^\./, ""))),
      hasId: target.id !== "" && clean(target.id),
    };
  });

/**
 * A point in a frame's own viewport: inside its border and padding. Returns undefined for a
 * transformed or scaled frame, whose mapping this does not attempt.
 */
const intoFrame = (frameElement: ElementHandle, x: number, y: number) =>
  frameElement.evaluate(
    (node, [px, py]) => {
      const frame = node as unknown as {
        getBoundingClientRect(): { left: number; top: number; width: number; height: number };
        readonly offsetWidth: number;
        readonly offsetHeight: number;
        readonly clientLeft: number;
        readonly clientTop: number;
      };
      const style = (
        globalThis as unknown as {
          getComputedStyle(element: unknown): {
            transform: string;
            paddingLeft: string;
            paddingTop: string;
          };
        }
      ).getComputedStyle(node);
      const rect = frame.getBoundingClientRect();
      if (
        style.transform !== "none" ||
        Math.abs(rect.width - frame.offsetWidth) > 0.5 ||
        Math.abs(rect.height - frame.offsetHeight) > 0.5
      )
        return null;
      return {
        x: px - rect.left - frame.clientLeft - Number.parseFloat(style.paddingLeft),
        y: py - rect.top - frame.clientTop - Number.parseFloat(style.paddingTop),
      };
    },
    [x, y] as const,
  );

const receiverAt = async (page: Page, x: number, y: number) => {
  let frame: Frame = page.mainFrame();
  let point: { x: number; y: number } | null = { x, y };
  for (let depth = 0; depth < MAX_FRAME_DEPTH && point !== null; depth++) {
    const hit = await frame.evaluateHandle(`(${HIT_AT})(${JSON.stringify([point.x, point.y])})`);
    const element = hit.asElement();
    if (element === null) {
      void hit.dispose().catch(() => undefined);
      return undefined;
    }
    try {
      const inner = await element.contentFrame();
      if (inner === null) return await describe(element);
      point = await intoFrame(element, point.x, point.y);
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
    // Identifiers stay only when the tab's cookie values were checked against them in time.
    const cookies = await within(tabCookies(page, [page.url()]), deadline);
    const usable = (token: string) =>
      cookies !== undefined &&
      IDENTIFIER.test(token.replace(/^[.#]/, "")) &&
      !TOKEN_LIKE.test(token) &&
      redactCookieValues(token, cookies) === token;
    const id = found.hasId ? found.identifiers[0] : undefined;
    const hint =
      id !== undefined && usable(id)
        ? ` #${id}`
        : found.identifiers.filter((token) => token.startsWith(".") && usable(token)).join("");
    const role = ROLE.test(found.role) ? ` (${found.role})` : "";
    const tag = /^[a-z][a-z0-9-]{0,30}$/.test(found.tag) ? found.tag : "element";
    return `<${tag}>${role}${hint ? ` ${hint.trim()}` : ""}`;
  } catch {
    return undefined;
  }
};
