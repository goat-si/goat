/**
 * Notices when a page asks a person for a secret: a password or one-time code field has focus,
 * or a passkey (WebAuthn) ceremony is running. The tab's SessionControl then goes private, so
 * agents neither act nor observe, viewers other than its controller and recordings get no frames.
 *
 * The page reports through a binding from a script in every frame. A page can only make itself
 * more private by lying, never less: hiding a field it shows is already the page's own choice.
 *
 * @module PreviewPrivateMode
 */
import type { Frame, Page } from "playwright-core";

const BINDING = "__goatPrivateMode";

/** Runs in each frame. Reports only changes, so focus moving within a form is quiet. */
const PRIVATE_MODE_SCRIPT = `(() => {
  const report = globalThis.${BINDING};
  if (typeof report !== "function" || globalThis.__goatPrivateModeWatching) return;
  globalThis.__goatPrivateModeWatching = true;
  const secretAutocomplete = /(^|\\s)(current-password|new-password|one-time-code)(\\s|$)/i;
  const focused = () => {
    let element = document.activeElement;
    while (element && element.shadowRoot && element.shadowRoot.activeElement)
      element = element.shadowRoot.activeElement;
    return element;
  };
  const secret = (element) =>
    element instanceof HTMLInputElement &&
    (element.type === "password" || secretAutocomplete.test(element.autocomplete || ""));
  let ceremonies = 0;
  let last = false;
  const update = () => {
    const on = ceremonies > 0 || secret(focused());
    if (on === last) return;
    last = on;
    void report(on);
  };
  addEventListener("focusin", update, true);
  addEventListener("focusout", () => setTimeout(update), true);
  addEventListener("pagehide", () => { ceremonies = 0; update(); });
  const credentials = globalThis.navigator && navigator.credentials;
  if (credentials) {
    for (const name of ["get", "create"]) {
      const original = credentials[name];
      if (typeof original !== "function") continue;
      credentials[name] = function (options) {
        if (!options || !options.publicKey) return original.call(this, options);
        ceremonies += 1;
        update();
        return Promise.resolve(original.call(this, options)).finally(() => {
          ceremonies -= 1;
          update();
        });
      };
    }
  }
  update();
})();`;

/**
 * Follows the page's frames and calls `onChange` with whether any of them holds a secret now.
 * Frames that go away stop counting.
 */
export async function watchPrivateMode(page: Page, onChange: (on: boolean) => void) {
  const privateFrames = new Set<Frame>();
  let last = false;
  const publish = () => {
    const on = privateFrames.size > 0;
    if (on === last) return;
    last = on;
    onChange(on);
  };
  await page.exposeBinding(BINDING, ({ frame }, on: unknown) => {
    if (on === true) privateFrames.add(frame);
    else privateFrames.delete(frame);
    publish();
  });
  page.on("framedetached", (frame) => {
    if (privateFrames.delete(frame)) publish();
  });
  page.on("framenavigated", (frame) => {
    if (privateFrames.delete(frame)) publish();
  });
  await page.addInitScript(PRIVATE_MODE_SCRIPT);
  // A page that was already open, such as a desktop tab GOAT adopted, gets it now too.
  await Promise.all(
    page.frames().map((frame) => frame.evaluate(PRIVATE_MODE_SCRIPT).catch(() => undefined)),
  );
}
