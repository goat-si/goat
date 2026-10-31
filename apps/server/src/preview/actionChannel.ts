import type { CDPSession, ElementHandle, Frame, Page } from "playwright-core";
import { BrowserControlInterrupted } from "./SessionControl.ts";

type Point = {
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "middle" | "right";
};
type Options = {
  readonly cdp: CDPSession;
  readonly page: Page;
  readonly signal: AbortSignal;
  readonly controlGeneration: () => void;
  readonly isFenced: () => boolean;
  readonly blockedFrame: () => boolean;
};

export const makeActionChannel = ({
  cdp,
  page,
  signal,
  controlGeneration,
  isFenced,
  blockedFrame,
}: Options) => {
  const check = () => {
    signal.throwIfAborted();
    controlGeneration();
    if (isFenced() || blockedFrame())
      throw new BrowserControlInterrupted("This browser host is blocked.", "blocked_url");
  };
  const sendFor = (session: CDPSession): CDPSession["send"] =>
    ((...args: Parameters<CDPSession["send"]>) => {
      check();
      return Reflect.apply(session.send, session, args);
    }) as CDPSession["send"];
  return {
    call: <T>(operation: () => T): T => {
      check();
      return operation();
    },
    send: sendFor(cdp),
    sendFor,
    detach: (session: CDPSession) => {
      check();
      return session.detach();
    },
    ownerFrame: (handle: ElementHandle) => {
      check();
      return handle.ownerFrame();
    },
    dispose: (handle: ElementHandle) => {
      check();
      return handle.dispose();
    },
    newCDPSession: (target: Page | Frame) => {
      check();
      return page.context().newCDPSession(target);
    },
    mouse: {
      down: (...args: Parameters<Page["mouse"]["down"]>) => {
        check();
        return page.mouse.down(...args);
      },
      up: (...args: Parameters<Page["mouse"]["up"]>) => {
        check();
        return page.mouse.up(...args);
      },
      move: (...args: Parameters<Page["mouse"]["move"]>) => {
        check();
        return page.mouse.move(...args);
      },
      wheel: (...args: Parameters<Page["mouse"]["wheel"]>) => {
        check();
        return page.mouse.wheel(...args);
      },
    },
    keyboard: {
      press: (...args: Parameters<Page["keyboard"]["press"]>) => {
        check();
        return page.keyboard.press(...args);
      },
      insertText: (...args: Parameters<Page["keyboard"]["insertText"]>) => {
        check();
        return page.keyboard.insertText(...args);
      },
    },
    evaluate: (
      handle: ElementHandle | Frame,
      fn: string | ((...args: never[]) => unknown),
      arg: unknown,
    ) => {
      check();
      return Reflect.apply(handle.evaluate, handle, [fn, arg]) as Promise<unknown>;
    },
    setInputFiles: (
      handle: ElementHandle,
      files: Parameters<ElementHandle["setInputFiles"]>[0],
    ) => {
      check();
      return handle.setInputFiles(files);
    },
    // These two reset commands clear a button held by GOAT after a cut.
    resetPressedInput: async (at: Point, session: CDPSession = cdp) => {
      try {
        await session.send("Input.cancelDragging");
      } finally {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: at.x,
          y: at.y,
          button: at.button ?? "left",
          buttons: 0,
          clickCount: 1,
        });
      }
    },
  };
};

export type ActionChannel = ReturnType<typeof makeActionChannel>;
