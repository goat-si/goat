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
/** Only well-known tags and roles are named; anything else a page set is left out. */
const TAGS = new Set(
  "a article aside button canvas details dialog div figure footer form header iframe img input label li main nav ol p section span summary svg table td th tr ul video".split(
    " ",
  ),
);
const ROLES = new Set(
  "alert alertdialog article banner button complementary contentinfo dialog form grid group heading img link listbox main menu menubar menuitem navigation option presentation region search status tab tabpanel toolbar tooltip".split(
    " ",
  ),
);

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

type PageNode = {
  readonly tagName?: string;
  readonly type?: string;
  readonly value?: unknown;
  readonly defaultValue?: unknown;
  readonly textContent?: string | null;
  readonly isContentEditable?: boolean;
  readonly children?: ArrayLike<PageNode>;
  readonly shadowRoot?: PageNode | null;
  readonly parentElement?: PageNode | null;
  getRootNode?(): { readonly host?: PageNode };
};
/**
 * Tag, role and identifiers. Identifiers holding a value of any password or visually masked
 * field in the document, open shadow roots included, are dropped; all are dropped when that
 * walk does not finish within its node budget.
 */
const describe = (element: ElementHandle) =>
  element.evaluate((node) => {
    const target = node as unknown as {
      readonly tagName: string;
      readonly id: string;
      readonly classList: Iterable<string>;
      readonly ownerDocument: { readonly documentElement: PageNode };
      getAttribute(name: string): string | null;
    };
    const view = globalThis as unknown as {
      getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
    };
    const secrets: Array<string> = [];
    const stack: Array<PageNode> = [target.ownerDocument.documentElement];
    // Bounds what is visited and what is queued, so a wide page cannot make this walk long.
    let budget = 20_000;
    let complete = true;
    walk: while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const field = current.tagName === "INPUT" || current.tagName === "TEXTAREA";
      if (field || current.isContentEditable === true) {
        const dots = view.getComputedStyle(current).getPropertyValue("-webkit-text-security");
        if (current.type === "password" || (dots !== "" && dots !== "none"))
          for (const value of field
            ? [current.value, current.defaultValue]
            : [current.textContent ?? ""])
            if (typeof value === "string")
              secrets.push(
                value,
                value
                  .replace(/[\u200b\u00ad]/g, "")
                  .trim()
                  .replace(/\s+/g, " "),
              );
      }
      const childCount = current.children?.length ?? 0;
      const queued = (current.shadowRoot ? 1 : 0) + childCount;
      if (queued > budget) {
        complete = false;
        break walk;
      }
      budget -= queued;
      if (current.shadowRoot) stack.push(current.shadowRoot);
      for (let index = 0; index < childCount; index++) {
        const child = current.children?.[index];
        if (child !== undefined) stack.push(child);
      }
    }
    const kept = secrets.filter((value) => value.trim() !== "");
    // A short value is matched as a whole part of the identifier, so "Ab" drops "#Ab" or "#x-Ab".
    const holds = (token: string, value: string) =>
      value.length >= 3 ? token.includes(value) : token.split(/[^A-Za-z0-9]+/).includes(value);
    const clean = (token: string) => complete && !kept.some((value) => holds(token, value));
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
 * A point in a frame's own viewport: inside its border and padding. Returns null when the frame
 * or any ancestor is transformed, rotated, translated or scaled; that mapping is not attempted.
 */
const intoFrame = (frameElement: ElementHandle, x: number, y: number) =>
  frameElement.evaluate(
    (node, [px, py]) => {
      const frame = node as unknown as PageNode & {
        getBoundingClientRect(): { left: number; top: number; width: number; height: number };
        readonly offsetWidth: number;
        readonly offsetHeight: number;
        readonly clientLeft: number;
        readonly clientTop: number;
      };
      const view = globalThis as unknown as {
        getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
      };
      for (let current: PageNode | null | undefined = frame; current;) {
        const style = view.getComputedStyle(current);
        for (const property of ["transform", "rotate", "scale", "translate", "zoom"]) {
          const value = style.getPropertyValue(property);
          if (value !== "" && value !== "none" && !(property === "zoom" && value === "1"))
            return null;
        }
        current = current.parentElement ?? current.getRootNode?.().host;
      }
      const rect = frame.getBoundingClientRect();
      if (
        Math.abs(rect.width - frame.offsetWidth) > 0.5 ||
        Math.abs(rect.height - frame.offsetHeight) > 0.5
      )
        return null;
      const style = view.getComputedStyle(frame);
      return {
        x:
          px -
          rect.left -
          frame.clientLeft -
          Number.parseFloat(style.getPropertyValue("padding-left")),
        y:
          py -
          rect.top -
          frame.clientTop -
          Number.parseFloat(style.getPropertyValue("padding-top")),
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
    const role = ROLES.has(found.role) ? ` (${found.role})` : "";
    const tag = TAGS.has(found.tag) ? found.tag : "element";
    return `<${tag}>${role}${hint ? ` ${hint.trim()}` : ""}`;
  } catch {
    return undefined;
  }
};
