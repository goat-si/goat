import type { CDPSession } from "playwright-core";

/**
 * Makes the page ignore mouse and key input until each given action settles. Used when Stop or a
 * secret field cuts an agent action after its gate: Playwright cannot recall an action, so the
 * tab drops whatever it still sends. A person's input in that window is dropped too, for at most
 * the action's dispatch timeout. Inserted text is not held (Chromium delivers it regardless), so
 * typing sends it as one call right after the gate.
 */
export const inputFence = (cdp: CDPSession) => {
  let held = 0;
  const ignore = (on: boolean) =>
    void cdp.send("Input.setIgnoreInputEvents", { ignore: on }).catch(() => undefined);
  return (work: Promise<unknown>) => {
    if (held++ === 0) ignore(true);
    const release = () => {
      if (--held === 0) ignore(false);
    };
    work.then(release, release);
  };
};
