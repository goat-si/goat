import type { ComputerUseCursorEvent } from "@goat/contracts";
import { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";

export interface ScreenCursorRoute {
  readonly threadId: string;
  readonly kind: "app" | "tab";
  readonly tabId?: string;
}

/** Only the host-owned target binding supplies a route; the guest's event cannot choose one. */
export class ScreenCursorPublisher extends Context.Service<
  ScreenCursorPublisher,
  { readonly publish: (event: ComputerUseCursorEvent, route: ScreenCursorRoute) => Effect.Effect<void> }
>()("goat/cua/ScreenCursorPublisher") {}

export const layer = Layer.effect(
  ScreenCursorPublisher,
  Effect.gen(function* () {
    const primitives = yield* ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel;
    const browser = yield* ServerBrowser.ServerBrowser;
    return ScreenCursorPublisher.of({
      publish: Effect.fn("ScreenCursorPublisher.publish")(function* (event, route) {
        if (route.kind === "app") {
          if (!(yield* primitives.cursor({ threadId: ThreadId.make(route.threadId), event })) &&
              event.op === "hide")
            yield* Effect.logWarning("screen cursor phase did not reach the live computer-use proxy");
          return;
        }
        if (route.tabId !== undefined)
          yield* browser.cursorState?.({
            threadId: route.threadId,
            tabId: route.tabId,
            cursor: { identity: event.identity, phase: event.phase },
          }) ?? Effect.void;
      }),
    });
  }),
);
