import { PREVIEW_AGENT_INPUT_HELD_GLOBAL, PREVIEW_AGENT_INPUT_HOLD_MAX_MS } from "@goat/contracts";
import type { CDPSession } from "playwright-core";

/**
 * Makes the page ignore mouse and key input until each given action settles. Used when Stop or a
 * secret field cuts an agent action after its gate: Playwright cannot recall an action, so the
 * tab drops whatever it still sends. A person's input in that window is dropped too, for at most
 * the action's dispatch timeout. Chromium delivers inserted text regardless, so typing sends it
 * as one call right after the gate; the desktop relay, which waits before inserting, reads the
 * page flag set here and drops it.
 */
export const inputFence = (cdp: CDPSession) => {
  let held = 0;
  const hold = (on: boolean) => {
    void cdp.send("Input.setIgnoreInputEvents", { ignore: on }).catch(() => undefined);
    // A deadline, not a flag: if the release never reaches the page (a relay that reconnects),
    // the hold still ends.
    const until = on ? `Date.now() + ${PREVIEW_AGENT_INPUT_HOLD_MAX_MS}` : "0";
    void cdp
      .send("Runtime.evaluate", {
        expression: `globalThis.${PREVIEW_AGENT_INPUT_HELD_GLOBAL} = ${until}`,
      })
      .catch(() => undefined);
  };
  return (work: Promise<unknown>) => {
    if (held++ === 0) hold(true);
    const release = () => {
      if (--held === 0) hold(false);
    };
    work.then(release, release);
  };
};
